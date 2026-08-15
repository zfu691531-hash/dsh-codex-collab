import { randomUUID } from "node:crypto";
import { Codes, CodexCollabError } from "../errors";
import type { CodexBackend, CodexReplyRequest, CodexResult, CodexSession, CodexStartRequest } from "./types";

export interface FakeBackendOptions {
  /** If true, `connect()` throws {@link Codes.CODEX_UNAVAILABLE}. */
  unavailable?: boolean;
  /** Diagnostic detail used when unavailable. */
  unavailableMessage?: string;
  /** Every `start`/`reply` fails with `CODEX_TASK_FAILED` when true. */
  failTasks?: boolean;
  /** Fixed thread id returned by `start` (default: uuid). */
  threadId?: string;
  /** Simulated latency per call. */
  delayMs?: number;
  /** Throw non-CodexCollabError to exercise degradation. */
  throwInternal?: boolean;
}

/**
 * Deterministic, in-memory Codex backend used by unit tests and a documented
 * local smoke run. It implements the same contract as the MCP adapter.
 */
export class FakeBackend implements CodexBackend {
  private readonly opts: FakeBackendOptions;
  started: number = 0;
  replied: number = 0;
  closed = false;
  sessions = new Map<string, CodexSession>();
  lastStartRequest?: CodexStartRequest;
  lastReplyRequest?: CodexReplyRequest;

  constructor(opts: FakeBackendOptions = {}) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    if (this.opts.unavailable) {
      throw new CodexCollabError(
        Codes.CODEX_UNAVAILABLE,
        this.opts.unavailableMessage ?? "codex app-server is unavailable (fake backend configured unavailable)",
      );
    }
  }

  async start(request: CodexStartRequest): Promise<CodexResult> {
    this.ensureAvailable();
    await this.delay();
    this.started += 1;
    this.lastStartRequest = request;
    if (this.opts.failTasks) {
      throw new CodexCollabError(Codes.CODEX_TASK_FAILED, "fake backend: task start failed");
    }
    if (this.opts.throwInternal) {
      throw new Error("fake backend: internal failure");
    }
    const threadId = this.opts.threadId ?? randomUUID();
    this.sessions.set(threadId, { threadId, state: "awaiting-reply" });
    return { threadId, content: `DSH_CODEX_MCP_OK\nstarted: ${request.prompt.slice(0, 60)}`, ok: true };
  }

  async reply(request: CodexReplyRequest): Promise<CodexResult> {
    this.ensureAvailable();
    await this.delay();
    this.replied += 1;
    this.lastReplyRequest = request;
    if (this.opts.failTasks) {
      throw new CodexCollabError(Codes.CODEX_TASK_FAILED, "fake backend: reply failed");
    }
    if (this.opts.throwInternal) {
      throw new Error("fake backend: internal failure");
    }
    const existing = this.sessions.get(request.threadId);
    if (!existing) {
      throw new CodexCollabError(Codes.THREAD_NOT_FOUND, `unknown thread ${request.threadId}`);
    }
    existing.lastContent = request.prompt;
    return { threadId: request.threadId, content: `DSH_CODEX_REPLY_OK\ncontinued thread ${request.threadId}`, ok: true };
  }

  available(): boolean {
    return !this.opts.unavailable;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  private async delay(): Promise<void> {
    if (this.opts.delayMs) {
      await new Promise((r) => setTimeout(r, this.opts.delayMs));
    }
  }

  private ensureAvailable(): void {
    if (this.opts.unavailable || this.closed) {
      throw new CodexCollabError(
        Codes.CODEX_UNAVAILABLE,
        this.opts.unavailableMessage ?? "codex app-server is unavailable",
      );
    }
  }
}
