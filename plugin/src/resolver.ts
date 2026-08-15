import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { ProcessInvoker } from "./status";

/**
 * Executable resolution for `codex`.
 *
 * The resolver NEVER hard-codes a user-name home path. Candidates are probed
 * with an actual `codex --version` invocation (a stat alone is NOT enough:
 * Windows App Execution Aliases stat successfully but fail to launch with
 * "Access denied"), and the FIRST candidate whose probe succeeds wins.
 * Every candidate and its failure reason is reported to the caller so the
 * final error message shows all paths tried.
 *
 * Candidate order:
 *  - `codexCommand` config override (tried first when non-empty);
 *  - the `CODEX_BIN` environment variable;
 *  - `codex` / `codex.cmd` on PATH;
 *  - the user's home `.codex/.sandbox-bin` copy (resolved via `homedir()`);
 *  - the Windows packaged AppExecutionAlias location (last, because it
 *    commonly fails at launch).
 */

export interface Candidate {
  /** Path as configured / found. */
  path: string;
  /** Where the candidate came from. */
  source: "config" | "env" | "path" | "home" | "packaged";
}

export interface ResolveResult {
  executable: string;
  candidates: Candidate[];
  /** Paths tried that were not usable, with a reason. */
  failures: { path: string; reason: string }[];
}

export interface ExecutableResolver {
  resolve(): Promise<ResolveResult>;
}

/** Windows-only: resolve the AppExecutionAlias provider path (no user name). */
function packagedExecutable(env: NodeJS.ProcessEnv): string {
  const local = env["LOCALAPPDATA"];
  return local ? path.join(local, "Microsoft\\WindowsApps\\codex.exe") : "";
}

/** Whether `p` exists and is a regular file (existence only, NOT launcher check). */
async function usable(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isFile();
  } catch {
    return false;
  }
}

/** Whether a bare command name resolves to an existing file on PATH. */
async function onPath(
  name: string,
  env: NodeJS.ProcessEnv,
  fileExists: (candidate: string) => Promise<boolean> = usable,
): Promise<boolean> {
  const pathVar = env["PATH"] ?? "";
  const exts = (env["PATHEXT"] ?? ".EXE;.CMD;.BAT;.COM").split(";").filter((e) => e.length > 0);
  const dirs = pathVar.split(path.delimiter);
  for (const dir of dirs) {
    // For a name that already carries an extension (e.g. codex.cmd), do not
    // append PATHEXT again — Windows would look for codex.cmd.EXE.
    const hasExt = path.extname(name).length > 0;
    const names = hasExt ? [name] : exts.map((ext) => name + ext);
    for (const candidate of names) {
      const p = path.join(dir, candidate);
      if (await fileExists(p)) return true;
    }
  }
  return false;
}

/**
 * Default resolver. `codexCommand` (non-empty) wins; otherwise probe a curated
 * candidate list, invoking `codex --version` per candidate until one succeeds.
 */
export function defaultResolver(
  codexCommand: string,
  env: NodeJS.ProcessEnv = process.env,
  invoke: ProcessInvoker = async (cmd, args, opts) => {
    const { invokeProcess } = await import("./status");
    return invokeProcess(cmd, args, opts);
  },
  fileExists: (candidate: string) => Promise<boolean> = usable,
  homeDirectory = homedir(),
): ExecutableResolver {
  return {
    async resolve() {
      const candidates: Candidate[] = [];
      if (codexCommand.trim()) {
        candidates.push({ path: codexCommand.trim(), source: "config" });
      }
      const envBin = env["CODEX_BIN"];
      if (envBin?.trim()) {
        candidates.push({ path: envBin.trim(), source: "env" });
      }
      candidates.push({ path: "codex", source: "path" });
      candidates.push({ path: "codex.cmd", source: "path" });
      const home = homeDirectory;
      if (home) {
        candidates.push({
          path: path.join(home, ".codex", ".sandbox-bin", "codex.exe"),
          source: "home",
        });
      }
      const packaged = packagedExecutable(env);
      if (packaged) {
        candidates.push({ path: packaged, source: "packaged" });
      }

      const failures: ResolveResult["failures"] = [];
      for (const c of candidates) {
        const exists = c.path === "codex" || c.path === "codex.cmd"
          ? await onPath(c.path, env, fileExists)
          : await fileExists(c.path);
        if (!exists) {
          failures.push({ path: c.path, reason: "not found or not a file" });
          continue;
        }
        // A successful stat is not enough: verify it actually launches and
        // answers --version. A WindowsApps alias that stat-succeeds but fails
        // to launch must NOT be returned.
        let probe;
        try {
          probe = await invoke(c.path, ["--version"], { timeoutMs: 5000 });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          failures.push({ path: c.path, reason: `codex --version could not start: ${message}` });
          continue;
        }
        if (probe.code !== 0) {
          failures.push({ path: c.path, reason: `codex --version failed (${probe.code ?? "error"})${probe.stderr ? `: ${probe.stderr.trim().slice(0, 120)}` : ""}` });
          continue;
        }
        return { executable: c.path, candidates, failures };
      }
      return { executable: "", candidates, failures };
    },
  };
}

/** `fs.access` re-export so consumers can verify an explicit executable. */
export async function executableAccessible(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}
