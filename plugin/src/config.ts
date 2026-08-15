import z from "@deepseek-ai/schemastery";

/**
 * Plugin configuration, validated by Schemastery at load time.
 *
 * `codexCommand` is intentionally OPTIONAL and must never default to a
 * user-name path: the executable resolver probes a safe candidate list and
 * reports every attempted path. When set, `codexCommand` is tried first.
 */
export const Config = z.object({
  /** Absolute path to a known-good `codex` executable (optional). */
  codexCommand: z.string().default(""),
  /** Optional fallback workspace when a DSH tool call omits cwd. */
  defaultCwd: z.string().default(""),
  /** How long `codex --version` / `codex app-server --help` may take. */
  statusCommandTimeoutMs: z.number().default(5000),
  /** Max wall time for one `codex` / `codex-reply` MCP call. */
  taskTimeoutMs: z.number().default(5 * 60 * 1000),
  /** Max time to wait for the app-server process to become ready. */
  connectTimeoutMs: z.number().default(15 * 1000),
  /** Keep the app-server child alive across calls until plugin dispose. */
  keepAlive: z.boolean().default(true),
});

export type Config = ReturnType<typeof Config>;
