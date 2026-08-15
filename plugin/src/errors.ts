/**
 * Stable, model-visible error taxonomy for the codex-collab plugin.
 *
 * Every failure surfaced to the model is a {@link Codes}.
 * The `code` string is compact and stable; DSH tool plumbing can route on it.
 */

export const Codes = {
  /** Codex CLI / app-server is not detected. Message includes all tried paths. */
  CODEX_UNAVAILABLE: "CODEX_UNAVAILABLE",
  /** A Codex task/thread operation failed (server error, exit, timeout...). */
  CODEX_TASK_FAILED: "CODEX_TASK_FAILED",
  /** The requested threadId is not present in the store. */
  THREAD_NOT_FOUND: "THREAD_NOT_FOUND",
  /** Prompt text shows high-confidence evidence of lossy character encoding. */
  PROMPT_ENCODING_CORRUPTED: "PROMPT_ENCODING_CORRUPTED",
  /** Internal invariant violation or unexpected local error. */
  INTERNAL: "INTERNAL",
} as const;

export type Code = (typeof Codes)[keyof typeof Codes];

export interface CodexCollabErrorData {
  code: Code;
  message: string;
}

/** Wrapper carrying a stable {@link Code} plus a human-readable message. */
export class CodexCollabError extends Error {
  readonly code: Code;

  constructor(code: Code, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CodexCollabError";
    this.code = code;
  }
}

export function asCodexCollabError(value: unknown): CodexCollabError {
  if (value instanceof CodexCollabError) return value;
  const message = value instanceof Error ? value.message : String(value);
  return new CodexCollabError(Codes.INTERNAL, message, { cause: value });
}
