import { createHash, createHmac, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { assertUtf8TransportIntegrity } from "./prompt-integrity";

const execFileAsync = promisify(execFile);

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

function b64url(value: Buffer): string {
  return value.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function dshHome(): string {
  const configured = process.env["DSH_HOME"]?.trim();
  return configured ? path.resolve(configured) : path.join(homedir(), ".dsh");
}

/**
 * The Desktop/Web Host protects its loopback API with an authority-bound signed
 * cookie. The signing secret lives in the credential record written by the Host
 * itself, so a local companion can mint the same cookie the browser would hold.
 */
async function readBrowserSessionSecret(): Promise<Buffer> {
  const file = path.join(dshHome(), ".credentials.yaml");
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    throw new DshApiError(
      "DSH_CREDENTIALS_UNAVAILABLE",
      `cannot read ${file}; start DeepSeek Harness once so it creates the browser-session credential`,
      undefined,
      { cause: error },
    );
  }
  const lines = text.split(/\r?\n/u);
  const start = lines.findIndex((line) => /^\s*client-connection\/browser-session:\s*$/u.test(line));
  if (start < 0) {
    throw new DshApiError(
      "DSH_CREDENTIALS_INVALID",
      `no client-connection/browser-session record in ${file}`,
    );
  }
  const baseIndent = (lines[start]!.match(/^\s*/u)?.[0] ?? "").length;
  let section = "";
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim().length === 0) continue;
    const indent = (line.match(/^\s*/u)?.[0] ?? "").length;
    if (indent <= baseIndent) break;
    section += `${line}\n`;
  }
  const secret = /^\s*secret:\s*["']?([A-Za-z0-9_-]+)["']?\s*$/mu.exec(section)?.[1];
  if (!secret) {
    throw new DshApiError(
      "DSH_CREDENTIALS_INVALID",
      `no usable client-connection/browser-session secret in ${file}`,
    );
  }
  const bytes = Buffer.from(secret, "base64url");
  if (bytes.byteLength !== 32) {
    throw new DshApiError("DSH_CREDENTIALS_INVALID", "browser-session secret must decode to 32 bytes");
  }
  return bytes;
}

/** Cookie name and value exactly as the Host's BrowserAuth verifies them. */
export function browserSessionCookie(authority: string, secret: Buffer, now = Date.now()): string {
  const name = `dsh-auth-${b64url(createHash("sha256").update(authority).digest())}`;
  const payload = {
    version: 1,
    authority,
    issuedAt: now,
    expiresAt: now + 24 * 60 * 60 * 1000,
  };
  const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const signature = b64url(createHmac("sha256", secret).update(body).digest());
  return `${name}=v1.${body}.${signature}`;
}

async function hostPids(): Promise<number[]> {
  if (process.platform === "win32") {
    const { stdout } = await execFileAsync(
      "tasklist",
      ["/FI", "IMAGENAME eq DeepSeek Harness.exe", "/FO", "CSV", "/NH"],
      { maxBuffer: 4 * 1024 * 1024, windowsHide: true },
    );
    return stdout
      .split(/\r?\n/u)
      .map((line) => line.match(/^"DeepSeek Harness\.exe","(\d+)"/u))
      .filter((match): match is RegExpMatchArray => match !== null)
      .map((match) => Number(match[1]));
  }
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,command="], { maxBuffer: 4 * 1024 * 1024 });
  return stdout
    .split(/\r?\n/u)
    .map((line) => /^\s*(\d+)\s+(.+)$/u.exec(line))
    .filter((match): match is RegExpExecArray => {
      if (match === null) return false;
      const command = match[2] ?? "";
      return process.platform === "darwin" ? /DeepSeek Harness\.app/u.test(command) : /dsh-desktop-host/u.test(command);
    })
    .map((match) => Number(match[1]));
}

async function listeningPorts(pid: number): Promise<number[]> {
  if (process.platform === "win32") {
    const { stdout } = await execFileAsync("netstat", ["-ano", "-p", "tcp"], {
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      encoding: "buffer",
    } as never);
    const text = Buffer.isBuffer(stdout) ? stdout.toString("latin1") : String(stdout);
    const ports: number[] = [];
    for (const line of text.split(/\r?\n/u)) {
      const match = /^\s*TCP\s+127\.0\.0\.1:(\d+)\s+\S+\s+\S+\s+(\d+)\s*$/u.exec(line);
      if (match && Number(match[2]) === pid) ports.push(Number(match[1]));
    }
    return ports;
  }
  const { stdout } = await execFileAsync("lsof", ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-Fn"]);
  return stdout
    .split(/\r?\n/u)
    .map((line) => line.match(/^n127\.0\.0\.1:(\d+)$/u))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => Number(match[1]));
}

/** Discover the current Host loopback origin (the port is chosen at each launch). */
export async function discoverDshBaseUrl(): Promise<string> {
  const secret = await readBrowserSessionSecret();
  const pids = await hostPids();
  if (pids.length === 0) {
    throw new DshApiError("DSH_HOST_NOT_FOUND", "DeepSeek Harness is not running; start it and retry");
  }
  for (const pid of pids) {
    let ports: number[] = [];
    try {
      ports = await listeningPorts(pid);
    } catch {
      continue;
    }
    for (const port of ports) {
      const origin = `http://127.0.0.1:${port}`;
      if (await probeHost(origin, secret)) return origin;
    }
  }
  throw new DshApiError("DSH_HOST_NOT_FOUND", "DeepSeek Harness is running but its Host API refused the probe");
}

async function probeHost(origin: string, secret: Buffer): Promise<boolean> {
  const authority = new URL(origin).host;
  const rpcId = `dsh-collab-probe-${Date.now()}`;
  try {
    const response = await fetch(new URL("/api/session/list", origin), {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        cookie: browserSessionCookie(authority, secret),
      },
      body: JSON.stringify({
        type: "client-request",
        rpcId,
        method: "session/list",
        payload: { args: { _request: {} } },
      }),
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return false;
    const body: unknown = await response.json();
    return isRecord(body) && body.type === "server-response" && body.rpcId === rpcId && isRecord(body.result) && body.result.ok === true;
  } catch {
    return false;
  }
}

/**
 * Minimal client for DSH's official loopback Host API used by its own Web UI.
 *
 * Wire contract of the 0.2.x "typert" gateway, verified against 0.2.1-rc.2:
 *   POST /api/<slash-endpoint>   (e.g. /api/session/list)
 *   { type: "client-request", rpcId, method: "<slash-endpoint>",
 *     payload: { args: { <parameter-name>: request } } }
 * The parameter name comes from the endpoint descriptor: `_request` for
 * session/list, `request` for the other session endpoints.
 */
export class DshApiClient {
  private readonly configuredBase: URL | undefined;
  private resolvedBase: URL | undefined;
  private secret: Buffer | undefined;
  private readonly timeoutMs: number;
  private readonly fetcher: typeof fetch;

  constructor(options: DshApiClientOptions = {}) {
    const raw = (options.baseUrl ?? process.env["DSH_BASE_URL"] ?? "auto").trim();
    this.configuredBase = raw && raw.toLowerCase() !== "auto" ? assertLoopbackBase(raw) : undefined;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.fetcher = options.fetcher ?? fetch;
  }

  private async baseUrl(): Promise<URL> {
    if (this.configuredBase) return this.configuredBase;
    if (this.resolvedBase) return this.resolvedBase;
    const discovered = await discoverDshBaseUrl();
    this.resolvedBase = new URL(discovered);
    return this.resolvedBase;
  }

  private async cookie(base: URL): Promise<string> {
    this.secret ??= await readBrowserSessionSecret();
    return browserSessionCookie(base.host, this.secret);
  }

  private static parameterName(method: string): string {
    return method === "session.list" ? "_request" : "request";
  }

  async call<T>(method: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const base = await this.baseUrl();
    const endpoint = method.replaceAll(".", "/");
    const rpcId = randomUUID();
    const invoke = async (parameterName: string) => {
      let response: Response;
      try {
        response = await this.fetcher(new URL(`/api/${endpoint}`, base).toString(), {
          method: "POST",
          headers: {
            "content-type": "application/json; charset=utf-8",
            cookie: await this.cookie(base),
          },
          body: JSON.stringify({
            type: "client-request",
            rpcId,
            method: endpoint,
            payload: { args: { [parameterName]: payload } },
          }),
          signal: mergeSignal(this.timeoutMs, signal),
        });
      } catch (error) {
        throw new DshApiError("DSH_UNAVAILABLE", `cannot reach DSH at ${base.origin}: ${String(error)}`, undefined, {
          cause: error,
        });
      }
      if (!response.ok) {
        throw new DshApiError("DSH_TRANSPORT_ERROR", `DSH ${endpoint} returned HTTP ${response.status}`);
      }
      return (await response.json()) as unknown;
    };

    let body = await invoke(DshApiClient.parameterName(method));
    if (isRecord(body) && isRecord(body.result) && body.result.ok === false) {
      const error = body.result.error;
      const message = isRecord(error) && typeof error.message === "string" ? error.message : "";
      // Tolerate descriptor naming drift: retry once with the other argument key.
      if (message.includes('missing "request"') || message.includes('unexpected "_request"')) {
        body = await invoke(DshApiClient.parameterName(method) === "request" ? "_request" : "request");
      } else if (message.includes("does not match endpoint")) {
        throw new DshApiError("DSH_PROTOCOL_ERROR", `DSH ${method}: ${message}`);
      }
    }

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
      {
        requestId: randomUUID(),
        sessionId,
        mode,
        content: [{ type: "text", text: verifiedPrompt }],
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
      signal,
    );
  }

  /**
   * Recent history from the cold-safe `session/page` endpoint. 0.2.x removed
   * `session.history`; the page needs the log cut (`throughSeq`), which the
   * session summary exposes as its projection cursor.
   */
  async history(sessionId: string, signal?: AbortSignal) {
    const sessions = await this.listSessions(signal);
    const summary = sessions.items.find((item) => item.sessionId === sessionId);
    const throughSeq = summary && typeof (summary as { projections?: { asOfSeq?: number } }).projections?.asOfSeq === "number"
      ? (summary as { projections: { asOfSeq: number } }).projections.asOfSeq
      : 0;
    const page = await this.call<{ records: Array<{ type: string; event: { type: string; seq: number; time: number; data: unknown } }>; hasMore: boolean }>(
      "session.page",
      { address: { kind: "session", sessionId }, throughSeq, maxMessages: 64 },
      signal,
    );
    return {
      events: page.records.filter((record) => record.type === "event").map((record) => ({ event: record.event })),
      hasMore: page.hasMore,
    };
  }

  listSessions(signal?: AbortSignal) {
    return this.call<{
      items: Array<{
        sessionId: string;
        running: boolean;
        blank: boolean;
        agentPreset?: string;
        cwd?: string;
        projections?: { asOfSeq?: number };
      }>;
    }>("session.list", {}, signal);
  }

  cancel(sessionId: string, signal?: AbortSignal) {
    return this.call<{ accepted: true }>("session.cancel", { sessionId }, signal);
  }
}
