import { AppServerBackend } from "./adapters/app-server";
import { FakeBackend } from "./adapters/fake";
import type { CodexBackend } from "./adapters/types";
import type { Config } from "./config";

export interface BackendSelection {
  kind: "app-server" | "mcp" | "fake";
  backend: CodexBackend;
}

/**
 * Choose the runtime backend.
 *
 * - With a resolved executable → official app-server JSONL backend. Threads
 *   created this way are visible in Codex Desktop's normal task list.
 * - Without one → an *unavailable* fake backend that throws
 *   `CODEX_UNAVAILABLE` on connect/start/reply. The plugin still activates and
 *   registers its tools; DSH startup never depends on Codex.
 */
export function defaultBackend(
  config: Config,
  executable: string | undefined,
  unavailableMessage?: string,
): BackendSelection {
  if (!executable) {
    return {
      kind: "fake",
      backend: new FakeBackend({
        unavailable: true,
        ...(unavailableMessage ? { unavailableMessage } : {}),
      }),
    };
  }
  return {
    kind: "app-server",
    backend: new AppServerBackend({
      executable,
      taskTimeoutMs: config.taskTimeoutMs,
      connectTimeoutMs: config.connectTimeoutMs,
      keepAlive: config.keepAlive,
      defaultApprovalPolicy: "never",
      defaultSandbox: "workspace-write",
      ...(config.defaultCwd ? { cwd: config.defaultCwd } : {}),
    }),
  };
}
