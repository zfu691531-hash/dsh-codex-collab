import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
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

const TOKEN_QUERY = "token";
const DEFAULT_AUTH_URL_RELATIVE_PATH = ["dsh-codex-collab", "auth-url.txt"];

interface AuthMaterial {
  token: string;
}

function authError(code: string, message: string): DshApiError {
  return new DshApiError(code, `${code}: ${message}`);
}

function assertToken(token: string): string {
  const normalized = token.trim();
  if (!normalized) throw authError("DSH_AUTH_CONFIG_ERROR", "DSH authentication token is empty");
  return normalized;
}

function assertLoopbackBase(raw: string): { url: URL; token?: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DshApiError("DSH_BASE_URL_INVALID", "DSH base URL is not a valid URL");
  }
  const host = url.hostname.toLowerCase();
  const loopback = host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
  if (url.protocol !== "http:" || !loopback || url.username || url.password) {
    throw new DshApiError("DSH_BASE_URL_INVALID", "DSH base URL must be an HTTP loopback address");
  }
  const tokens = url.searchParams.getAll(TOKEN_QUERY);
  if (tokens.length > 1 || tokens[0] === "") {
    throw authError("DSH_AUTH_CONFIG_ERROR", "DSH base URL contains an invalid authentication token");
  }
  const token = tokens.length === 1 ? assertToken(tokens[0]!) : undefined;
  url.search = "";
  url.hash = "";
  url.pathname = "/";
  return { url, token };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([timeout, signal]) : timeout;
}

function awaitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolvePromise, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolvePromise(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function cookieFromSetCookie(value: string | null): string | undefined {
  if (!value) return undefined;
  const first = value.split(";", 1)[0] ?? "";
  const separator = first.indexOf("=");
  if (separator <= 0) return undefined;
  const name = first.slice(0, separator).trim();
  const cookieValue = first.slice(separator + 1).trim();
  if (!/^dsh-auth-[A-Za-z0-9_-]+$/u.test(name) || !cookieValue) return undefined;
  return `${name}=${cookieValue}`;
}

/** Minimal client for DSH's official loopback Host API used by its own Web UI. */
export class DshApiClient {
  protected readonly baseUrl: URL;
  private readonly baseUrlToken?: string;
  protected readonly timeoutMs: number;
  private readonly fetcher: typeof fetch;
  private cookie?: string;
  private authExchange?: Promise<void>;

  constructor(options: DshApiClientOptions = {}) {
    const base = assertLoopbackBase(options.baseUrl ?? "http://127.0.0.1:3080");
    this.baseUrl = base.url;
    this.baseUrlToken = base.token;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.fetcher = options.fetcher ?? fetch;
  }

  async call<T>(method: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const rpcId = randomUUID();
    const endpoint = new URL(`/api/${method}`, this.baseUrl).toString();
    let response = await this.request(endpoint, method, rpcId, payload, signal);
    if (response.status === 401) {
      await this.authenticate(true, signal);
      response = await this.request(endpoint, method, rpcId, payload, signal);
      if (response.status === 401) {
        throw this.cookie
          ? authError("DSH_AUTH_FAILED", "DSH rejected authentication; refresh the DSH auth URL or token and retry")
          : authError("DSH_AUTH_REQUIRED", "DSH requires authentication; save the current DSH auth URL or set DSH_AUTH_TOKEN");
      }
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

  protected async authHeaders(signal?: AbortSignal): Promise<Record<string, string>> {
    await this.authenticate(false, signal);
    return this.cookie ? { cookie: this.cookie } : {};
  }

  private async request(
    endpoint: string,
    method: string,
    rpcId: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      "content-type": "application/json; charset=utf-8",
      ...(await this.authHeaders(signal)),
    };
    try {
      return await this.fetcher(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({ type: "client-request", rpcId, method, payload }),
        redirect: "manual",
        signal: mergeSignal(this.timeoutMs, signal),
      });
    } catch {
      throw new DshApiError("DSH_UNAVAILABLE", `cannot reach DSH at ${this.baseUrl.origin}`);
    }
  }

  private async authenticate(force: boolean, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (!force && this.cookie) return;
    if (this.authExchange) return await awaitWithSignal(this.authExchange, signal);
    const exchange = this.exchangeAuth(force).finally(() => {
      if (this.authExchange === exchange) this.authExchange = undefined;
    });
    this.authExchange = exchange;
    return await awaitWithSignal(exchange, signal);
  }

  private async exchangeAuth(force: boolean): Promise<void> {
    const material = await this.readAuthMaterial();
    if (!material) {
      this.cookie = undefined;
      if (force) {
        throw authError(
          "DSH_AUTH_REQUIRED",
          "DSH requires authentication; save the current DSH auth URL to ~/.dsh/dsh-codex-collab/auth-url.txt or set DSH_AUTH_TOKEN",
        );
      }
      return;
    }
    const endpoint = new URL("/", this.baseUrl);
    endpoint.searchParams.set(TOKEN_QUERY, material.token);
    let response: Response;
    try {
      response = await this.fetcher(endpoint.toString(), {
        method: "GET",
        headers: { accept: "text/html", "cache-control": "no-store" },
        redirect: "manual",
        signal: mergeSignal(this.timeoutMs),
      });
    } catch {
      throw authError("DSH_AUTH_UNAVAILABLE", `cannot authenticate DSH at ${this.baseUrl.origin}`);
    }
    const location = response.headers.get("location");
    const cookie = cookieFromSetCookie(response.headers.get("set-cookie"));
    if (response.status !== 303 || !isCleanAuthRedirect(location, this.baseUrl) || !cookie) {
      throw authError("DSH_AUTH_FAILED", "DSH authentication failed; refresh the DSH auth URL or token and retry");
    }
    this.cookie = cookie;
  }

  private async readAuthMaterial(): Promise<AuthMaterial | undefined> {
    const explicitToken = process.env.DSH_AUTH_TOKEN;
    if (explicitToken !== undefined) return { token: assertToken(explicitToken) };
    if (this.baseUrlToken !== undefined) return { token: this.baseUrlToken };

    const configuredPath = process.env.DSH_AUTH_URL_FILE?.trim();
    const isDefaultPath = !configuredPath;
    const authPath = resolve(configuredPath || join(process.env.DSH_HOME?.trim() || join(homedir(), ".dsh"), ...DEFAULT_AUTH_URL_RELATIVE_PATH));
    let contents: string;
    try {
      contents = await readFile(authPath, "utf8");
    } catch (error) {
      if (isDefaultPath && isMissingFile(error)) return undefined;
      if (isMissingFile(error)) {
        throw authError("DSH_AUTH_CONFIG_ERROR", "DSH_AUTH_URL_FILE is set but the authentication URL file is missing");
      }
      throw authError("DSH_AUTH_CONFIG_ERROR", "cannot read the DSH authentication URL file");
    }
    let authUrl: URL;
    try {
      authUrl = new URL(contents.trim());
    } catch {
      throw authError("DSH_AUTH_CONFIG_ERROR", "the DSH authentication URL file does not contain a valid URL");
    }
    if (authUrl.origin !== this.baseUrl.origin) {
      throw authError("DSH_AUTH_CONFIG_ERROR", "the DSH authentication URL does not match the configured DSH host");
    }
    const tokens = authUrl.searchParams.getAll(TOKEN_QUERY);
    if (tokens.length !== 1 || !tokens[0]) {
      throw authError("DSH_AUTH_CONFIG_ERROR", "the DSH authentication URL does not contain one token");
    }
    return { token: assertToken(tokens[0]) };
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

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isCleanAuthRedirect(location: string | null, baseUrl: URL): boolean {
  if (!location) return false;
  try {
    const target = new URL(location, baseUrl);
    return (
      target.origin === baseUrl.origin &&
      target.pathname === "/" &&
      target.search === "" &&
      target.hash === "" &&
      target.username === "" &&
      target.password === ""
    );
  } catch {
    return false;
  }
}
