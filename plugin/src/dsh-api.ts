import { randomUUID } from "node:crypto";
import { assertUtf8TransportIntegrity } from "./prompt-integrity";

export interface DshApiClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  fetcher?: typeof fetch;
}

export interface DshRpcErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

export class DshApiError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DshApiError";
    this.code = code;
    this.details = details;
  }
}

function assertLoopbackBase(raw: string): URL {
  const url = new URL(raw);
  const host = url.hostname.toLowerCase();
  const loopback = host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
  if (url.protocol !== "http:" || !loopback) {
    throw new DshApiError("DSH_BASE_URL_INVALID", `DSH base URL must be an HTTP loopback address, got ${raw}`);
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  return url;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([timeout, signal]) : timeout;
}

/** Minimal client for DSH's official loopback Host API used by its own Web UI. */
export class DshApiClient {
  private readonly baseUrl: URL;
  private readonly timeoutMs: number;
  private readonly fetcher: typeof fetch;

  constructor(options: DshApiClientOptions = {}) {
    this.baseUrl = assertLoopbackBase(options.baseUrl ?? "http://127.0.0.1:3080");
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.fetcher = options.fetcher ?? fetch;
  }

  async call<T>(method: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const rpcId = randomUUID();
    const endpoint = new URL(`/api/${method}`, this.baseUrl).toString();
    let response: Response;
    try {
      response = await this.fetcher(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ type: "client-request", rpcId, method, payload }),
        signal: mergeSignal(this.timeoutMs, signal),
      });
    } catch (error) {
      throw new DshApiError("DSH_UNAVAILABLE", `cannot reach DSH at ${this.baseUrl.origin}: ${String(error)}`, undefined, {
        cause: error,
      });
    }
    if (!response.ok) {
      throw new DshApiError("DSH_TRANSPORT_ERROR", `DSH ${method} returned HTTP ${response.status}`);
    }

    const body: unknown = await response.json();
    if (!isRecord(body) || body.type !== "server-response" || body.rpcId !== rpcId || !isRecord(body.result)) {
      throw new DshApiError("DSH_PROTOCOL_ERROR", `invalid DSH response envelope for ${method}`);
    }
    if (body.result.ok === false) {
      const error = body.result.error;
      if (isRecord(error) && typeof error.code === "string" && typeof error.message === "string") {
        throw new DshApiError(error.code, error.message, error.details);
      }
      throw new DshApiError("DSH_PROTOCOL_ERROR", `invalid DSH error response for ${method}`);
    }
    if (body.result.ok !== true || !("value" in body.result)) {
      throw new DshApiError("DSH_PROTOCOL_ERROR", `invalid DSH result for ${method}`);
    }
    return body.result.value as T;
  }

  createSession(input: { cwd?: string; agentPreset?: string }, signal?: AbortSignal) {
    return this.call<{ sessionId: string; agentPreset?: string }>("session.create", input, signal);
  }

  async prompt(sessionId: string, prompt: string, mode: "queue" | "steer" = "queue", signal?: AbortSignal) {
    const verifiedPrompt = assertUtf8TransportIntegrity(prompt);
    return await this.call<{ accepted: true }>(
      "session.prompt",
      { sessionId, mode, content: [{ type: "text", text: verifiedPrompt }] },
      signal,
    );
  }

  history(sessionId: string, signal?: AbortSignal) {
    return this.call<{ events: Array<{ event: import("./dsh-task-client").DshHistoryEvent }>; hasMore: boolean }>(
      "session.history",
      { sessionId, maxMessages: 32 },
      signal,
    );
  }

  listSessions(signal?: AbortSignal) {
    return this.call<{
      items: Array<{ sessionId: string; running: boolean; blank: boolean; agentPreset?: string; cwd?: string }>;
    }>("session.list", {}, signal);
  }

  cancel(sessionId: string, signal?: AbortSignal) {
    return this.call<{ accepted: true }>("session.cancel", { sessionId }, signal);
  }
}
