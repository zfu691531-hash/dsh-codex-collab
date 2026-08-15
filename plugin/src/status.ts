import { spawn, type ChildProcess } from "node:child_process";
import { Codes, CodexCollabError } from "./errors";

export interface StatusProbe {
  resolved: string;
  candidates: { path: string; source: string }[];
  failures: { path: string; reason: string }[];
  /** `codex --version` stdout, when the executable answered. */
  version: string | undefined;
  /** Whether `codex app-server --help` succeeded (legacy field name kept for compatibility). */
  mcpServerHelpOk: boolean;
  codexAvailable: boolean;
}

export interface ProcessInvoker {
  (command: string, args: string[], options: { timeoutMs: number; shell?: boolean }): Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
  }>;
}

/**
 * Run one short-lived probe command with a hard timeout, capturing output.
 * `shell: false` keeps argument passing safe; on Windows `codex` may be a
 * `.cmd` shim, so callers can opt into shell when resolving by name.
 */
export function invokeProcess(
  command: string,
  args: string[],
  options: { timeoutMs: number; shell?: boolean },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        shell: options.shell ?? false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      }) as ChildProcess;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      resolvePromise({ code: null, stdout: "", stderr: `[spawn error: ${message}]` });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        resolvePromise({ code: null, stdout, stderr: `${stderr}\n[probe timed out after ${options.timeoutMs}ms]`.trim() });
      }
    }, options.timeoutMs);
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ code: null, stdout, stderr: `[spawn error: ${err.message}]` });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    });
  });
}

/**
 * Probe Codex availability without touching any global config.
 * Does NOT modify `~/.codex` — only reads `--version` and `app-server --help`.
 * The final error message surfaces every tried path and its reason.
 */
export async function detectCodex(
  resolved: string,
  candidates: { path: string; source: string }[],
  failures: { path: string; reason: string }[],
  invoke: ProcessInvoker = invokeProcess,
  timeoutMs = 5000,
): Promise<StatusProbe> {
  const failuresLocal = [...failures];
  if (!resolved) {
    return {
      resolved: "",
      candidates,
      failures: failuresLocal,
      version: undefined,
      mcpServerHelpOk: false,
      codexAvailable: false,
    };
  }
  const versionResult = await invoke(resolved, ["--version"], { timeoutMs });
  const versionOk = versionResult.code === 0;
  const version = versionOk ? versionResult.stdout.trim() || versionResult.stderr.trim() : undefined;
  if (!versionOk) {
    failuresLocal.push({ path: resolved, reason: `codex --version failed (${versionResult.code})` });
  }
  const helpResult = await invoke(resolved, ["app-server", "--help"], { timeoutMs });
  const mcpServerHelpOk = helpResult.code === 0;
  if (!mcpServerHelpOk) {
    failuresLocal.push({ path: resolved, reason: `codex app-server --help failed (${helpResult.code})` });
  }
  const codexAvailable = versionOk && mcpServerHelpOk;
  return {
    resolved,
    candidates,
    failures: failuresLocal,
    version: versionOk ? version : undefined,
    mcpServerHelpOk,
    codexAvailable,
  };
}

export function unavailableError(probe: Pick<StatusProbe, "resolved" | "candidates" | "failures" | "mcpServerHelpOk">): CodexCollabError {
  const reasons = probe.failures.map((f) => `  - ${f.path}: ${f.reason}`).join("\n");
  const detail = reasons ? `\nTried paths:\n${reasons}` : "";
  return new CodexCollabError(
    Codes.CODEX_UNAVAILABLE,
    `Codex CLI / app-server is unavailable.${detail}`,
  );
}
