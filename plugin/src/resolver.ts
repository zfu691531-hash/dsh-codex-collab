import { access, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { ProcessInvoker } from "./status";

export interface Candidate {
  path: string;
  source: "config" | "env" | "desktop" | "path" | "packaged";
}
export interface ResolveResult {
  executable: string;
  /** Selection order, including candidates that failed. */
  candidates: Candidate[];
  failures: { path: string; reason: string }[];
}
export interface ExecutableResolver { resolve(): Promise<ResolveResult>; }
interface ResolverRuntime {
  platform?: NodeJS.Platform;
  listDirectories?: (directory: string) => Promise<string[]>;
  canonicalPath?: (file: string) => Promise<string>;
}
async function usable(file: string): Promise<boolean> {
  try { return (await stat(file)).isFile(); } catch { return false; }
}
interface Version { core: number[]; pre: string[]; }
function parseVersion(output: string): Version | undefined {
  const match = /^codex-cli\s+(\d+)\.(\d+)\.(\d+)(?:-([\dA-Za-z.-]+))?(?:\+[\dA-Za-z.-]+)?\s*$/mu.exec(output.trim());
  if (!match) return undefined;
  return { core: match.slice(1, 4).map(Number), pre: match[4]?.split(".") ?? [] };
}
/** SemVer: stable > prerelease; numeric identifiers compare numerically. */
function compareVersions(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) {
    if (a.core[i] !== b.core[i]) return a.core[i]! - b.core[i]!;
  }
  if (!a.pre.length || !b.pre.length) return Number(!a.pre.length) - Number(!b.pre.length);
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const left = a.pre[i], right = b.pre[i];
    if (left === undefined || right === undefined) return a.pre.length - b.pre.length;
    if (left === right) continue;
    const ln = /^\d+$/u.test(left), rn = /^\d+$/u.test(right);
    if (ln && rn) return Number(left) - Number(right);
    if (ln !== rn) return ln ? -1 : 1;
    return left < right ? -1 : 1;
  }
  return 0;
}

/**
 * config > CODEX_BIN > Windows desktop builds (highest probed SemVer first)
 * > absolute PATH entries > WindowsApps alias. Windows .sandbox-bin is excluded
 * even via overrides/symlinks. Each resolve rescans builds; no hash is pinned.
 * Discovery and launch failures are retained for codex_status diagnostics.
 */
export function defaultResolver(
  codexCommand: string,
  env: NodeJS.ProcessEnv = process.env,
  invoke: ProcessInvoker = async (cmd, args, opts) => {
    const { invokeProcess } = await import("./status");
    return invokeProcess(cmd, args, opts);
  },
  fileExists: (candidate: string) => Promise<boolean> = usable,
  // Retained for existing consumers; there is no sandbox home fallback.
  _homeDirectory = homedir(),
  runtime: ResolverRuntime = {},
): ExecutableResolver {
  const windows = (runtime.platform ?? process.platform) === "win32";
  const paths = windows ? path.win32 : path.posix;
  const listDirectories = runtime.listDirectories ?? (async (directory: string) =>
    (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name));
  const canonicalPath = runtime.canonicalPath ?? (async (file: string) => {
    try { return await realpath(file); } catch { return file; }
  });
  return {
    async resolve() {
      const candidates: Candidate[] = [];
      const failures: ResolveResult["failures"] = [];
      const finish = (executable: string): ResolveResult => ({
        executable,
        candidates,
        // Keep the existing diagnostic field: one ordered entry per candidate,
        // including successful/unused paths, followed by discovery failures.
        failures: [
          ...candidates.map((candidate, index) => {
            const failure = failures.find((item) => item.path === candidate.path);
            const version = probed.get(candidate.path);
            const reason = failure?.reason ?? (candidate.path === executable
              ? "selected: codex --version succeeded"
              : version ? "valid version; higher-priority candidate selected" : "not attempted; higher-priority candidate selected");
            return { path: candidate.path, reason: `candidate #${index + 1} [${candidate.source}]: ${reason}` };
          }),
          ...failures.filter((failure) => !candidates.some((candidate) => candidate.path === failure.path)),
        ],
      });
      const probed = new Map<string, Version | undefined>();
      const seen = new Set<string>();
      const add = (file: string, source: Candidate["source"]) => {
        const key = windows ? file.toLowerCase() : file;
        if (!seen.has(key)) { seen.add(key); candidates.push({ path: file, source }); }
      };
      const probe = async (file: string): Promise<Version | undefined> => {
        if (probed.has(file)) return probed.get(file);
        probed.set(file, undefined);
        if (windows && [file, await canonicalPath(file)].some((p) => /(?:^|[\\/])\.sandbox-bin(?:[\\/]|$)/iu.test(p))) {
          failures.push({ path: file, reason: "Windows .sandbox-bin executable excluded: use the desktop CLI or a supported standalone CLI" });
          return undefined;
        }
        if (!await fileExists(file)) {
          failures.push({ path: file, reason: "not found or not a file" });
          return undefined;
        }
        try {
          const result = await invoke(file, ["--version"], { timeoutMs: 5000 });
          if (result.code !== 0) {
            failures.push({ path: file, reason: `codex --version failed (${result.code ?? "error"}): ${result.stderr.trim().slice(0, 240)}` });
            return undefined;
          }
          const version = parseVersion(result.stdout) ?? parseVersion(result.stderr);
          if (!version) failures.push({ path: file, reason: "codex --version returned no recognizable codex-cli SemVer" });
          probed.set(file, version);
          return version;
        } catch (error) {
          failures.push({ path: file, reason: `codex --version could not start: ${error instanceof Error ? error.message : String(error)}` });
          return undefined;
        }
      };
      // Resolve PATH names to concrete files: never stat one file then launch
      // another through the inherited process PATH.
      const pathEntries = async (name: string): Promise<string[]> => {
        const dirs = (env["PATH"] || env["Path"] || "").split(windows ? ";" : ":").filter(Boolean);
        const extensions = windows && !paths.extname(name)
          ? (env["PATHEXT"] || ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean) : [""];
        const found: string[] = [];
        for (const dir of dirs) {
          for (const ext of extensions) {
            const file = paths.resolve(dir.replace(/^"|"$/gu, ""), `${name}${ext}`);
            if (await fileExists(file)) found.push(file);
          }
        }
        return found;
      };
      const addOverride = async (raw: string, source: "config" | "env") => {
        if (!raw.trim()) return;
        const value = raw.trim();
        if (/[\\/]/u.test(value) || paths.isAbsolute(value)) add(value, source);
        else {
          const found = await pathEntries(value);
          if (found.length) found.forEach((file) => add(file, source));
          else failures.push({ path: value, reason: "not found on PATH" });
        }
      };
      await addOverride(codexCommand, "config");
      await addOverride(env["CODEX_BIN"] ?? "", "env");
      const local = env["LOCALAPPDATA"];
      if (windows && local) {
        const root = paths.join(local, "OpenAI", "Codex", "bin");
        try {
          const builds = (await listDirectories(root)).sort();
          const desktop = builds.map((build) => paths.join(root, build, "codex.exe"));
          for (const file of desktop) await probe(file);
          desktop.sort((a, b) => {
            const av = probed.get(a), bv = probed.get(b);
            return av && bv ? compareVersions(bv, av) : Number(!!bv) - Number(!!av);
          });
          desktop.forEach((file) => add(file, "desktop"));
          if (!builds.length) failures.push({ path: root, reason: "no desktop CLI build directories found" });
        } catch (error) {
          failures.push({ path: root, reason: `desktop CLI discovery failed: ${error instanceof Error ? error.message : String(error)}` });
        }
      }
      const onPath = await pathEntries("codex");
      onPath.forEach((file) => add(file, "path"));
      if (!onPath.length) failures.push({ path: "codex", reason: "not found on PATH" });
      if (windows && local) add(paths.join(local, "Microsoft", "WindowsApps", "codex.exe"), "packaged");
      for (const candidate of candidates) {
        if (await probe(candidate.path)) return finish(candidate.path);
      }
      return finish("");
    },
  };
}
export async function executableAccessible(file: string): Promise<boolean> {
  try { await access(file); return true; } catch { return false; }
}
