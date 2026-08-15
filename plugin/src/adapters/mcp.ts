import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Codes, CodexCollabError, type Code } from "../errors";
import type {
  CodexApprovalPolicy,
  CodexBackend,
  CodexReplyRequest,
  CodexResult,
  CodexSandboxMode,
  CodexStartRequest,
} from "./types";
import { assertUtf8TransportIntegrity } from "../prompt-integrity";

export interface McpBackendOptions {
  /** Codex executable already resolved by the resolver. */
  executable: string;
  /** Per-call timeout. */
  taskTimeoutMs: number;
  /** Max wait for the server process to become ready. */
  connectTimeoutMs: number;
  /** Keep the stdio child across calls until close(). */
  keepAlive: boolean;
  /** Default permission policy when a call omits it. */
  defaultApprovalPolicy?: CodexApprovalPolicy;
  /** Default sandbox mode when a call omits it. */
  defaultSandbox?: CodexSandboxMode;
  /** Working directory for the spawn. */
  cwd?: string;
  /** Extra env inherited by the child (credentials are never written here). */
  env?: NodeJS.ProcessEnv;
}

const TOOL_CODEX = "codex";
const TOOL_CODEX_REPLY = "codex-reply";

/**
 * MCP stdio backend over `codex mcp-server`.
 *
 * - Spawns the resolved codex executable with `mcp-server` and speaks the MCP
 *   protocol via @modelcontextprotocol/sdk.
 * - `StdioClientTransport` owns the single child process; we never spawn a
 *   second one ourselves.
 * - Calls `codex` (start) / `codex-reply` (continue) with the V1 argument set:
 *   `prompt` required; optional `cwd`, `approval-policy`, `sandbox`, `model`,
 *   `config`, `base-instructions`, `compact-prompt`, `developer-instructions`.
 * - Output is `{threadId, content}`; fresh-run marker `DSH_CODEX_MCP_OK`,
 *   continued-run marker `DSH_CODEX_REPLY_OK`.
 * - Soft-fails: when the child cannot spawn or the server never becomes ready,
 *   `connect()` throws `CODEX_UNAVAILABLE` WITHOUT breaking DSH startup.
 */
export class McpBackend implements CodexBackend {
  private readonly opts: McpBackendOptions;
  private client: Client | undefined;
  private transport: StdioClientTransport | undefined;
  private connected = false;
  private closed = false;
  /** Single in-flight connect promise (undefined when idle). */
  private connecting: Promise<void> | undefined;

  constructor(opts: McpBackendOptions) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    if (this.closed) {
      throw new CodexCollabError(Codes.CODEX_UNAVAILABLE, "backend already closed");
    }
    if (this.connected) return;
    if (this.connecting) return this.connecting;
    const promise = this.connectOnce().finally(() => {
      this.connecting = undefined;
    });
    this.connecting = promise;
    return promise;
  }

  private async connectOnce(): Promise<void> {
    let transport: StdioClientTransport | undefined;
    try {
      const transportOptions = {
        command: this.opts.executable,
        args: ["mcp-server"],
        stderr: "pipe" as const,
        ...(this.opts.cwd ? { cwd: this.opts.cwd } : {}),
        ...(this.opts.env ? { env: cleanEnvironment(this.opts.env) } : {}),
      };
      transport = new StdioClientTransport(transportOptions);
      const client = new Client(
        { name: "dsh-codex-collab", version: "0.1.4" },
        { capabilities: {} },
      );
      this.transport = transport;
      this.client = client;

      await withTimeout(
        client.connect(transport),
        this.opts.connectTimeoutMs,
        `codex mcp-server did not become ready within ${this.opts.connectTimeoutMs}ms`,
      );
      this.connected = true;
    } catch (error) {
      // Tear down the transport we started; it closes the child it spawned.
      this.client = undefined;
      this.transport = undefined;
      try {
        await transport?.close();
      } catch {
        /* ignore */
      }
      if (error instanceof CodexCollabError) throw error;
      throw new CodexCollabError(
        Codes.CODEX_UNAVAILABLE,
        `failed to connect to codex mcp-server: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  async start(request: CodexStartRequest): Promise<CodexResult> {
    const prompt = assertUtf8TransportIntegrity(request.prompt);
    await this.connect();
    if (!this.client) throw new CodexCollabError(Codes.CODEX_UNAVAILABLE, "mcp client not connected");
    const args: Record<string, string> = { prompt };
    if (request.cwd) args["cwd"] = request.cwd;
    const perms = request.permissions ?? {};
    const approval = perms.approvalPolicy ?? this.opts.defaultApprovalPolicy;
    if (approval) args["approval-policy"] = approval;
    const sandbox = perms.sandbox ?? this.opts.defaultSandbox;
    if (sandbox) args["sandbox"] = sandbox;
    if (request.model) args["model"] = request.model;
    if (request.extra) {
      for (const [k, v] of Object.entries(request.extra)) {
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
          args[k] = String(v);
        }
      }
    }
    return await this.call(TOOL_CODEX, args);
  }

  async reply(request: CodexReplyRequest): Promise<CodexResult> {
    const prompt = assertUtf8TransportIntegrity(request.prompt);
    await this.connect();
    if (!this.client) throw new CodexCollabError(Codes.CODEX_UNAVAILABLE, "mcp client not connected");
    const args: Record<string, string> = { prompt, threadId: request.threadId };
    return await this.call(TOOL_CODEX_REPLY, args);
  }

  private async call(tool: string, args: Record<string, string>): Promise<CodexResult> {
    if (!this.client) throw new CodexCollabError(Codes.CODEX_UNAVAILABLE, "mcp client not connected");
    try {
      const result = await withTimeout(
        this.client.callTool({ name: tool, arguments: args }),
        this.opts.taskTimeoutMs,
        `codex MCP call ${tool} timed out after ${this.opts.taskTimeoutMs}ms`,
        Codes.CODEX_TASK_FAILED,
      );
      return parseToolOutput(result);
    } catch (error) {
      if (error instanceof CodexCollabError) throw error;
      throw new CodexCollabError(Codes.CODEX_TASK_FAILED, `codex MCP call ${tool} failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    } finally {
      if (!this.opts.keepAlive) await this.disconnect();
    }
  }

  available(): boolean {
    return this.connected && !this.closed;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.disconnect();
  }

  private async disconnect(): Promise<void> {
    const client = this.client;
    const transport = this.transport;
    this.connected = false;
    this.client = undefined;
    this.transport = undefined;
    try {
      await client?.close();
    } catch {
      /* ignore */
    }
    try {
      await transport?.close();
    } catch {
      /* ignore */
    }
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
  code: Code = Codes.CODEX_UNAVAILABLE,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new CodexCollabError(code, message)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

function cleanEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

/**
 * Parse a real `CallToolResult` into the canonical {@link CodexResult}.
 *
 * The verified local shape is:
 *   { content: [{type:"text", text:"DSH_CODEX_MCP_OK"}],
 *     structuredContent: { threadId: "...", content: "..." } }
 *
 * Rules:
 *  - `structuredContent` is the AUTHORITATIVE source; when present we strictly
 *    require a string `threadId` (non-empty) and a `content` (string, may be
 *    empty). A missing/typed-wrong `threadId` is a hard `CODEX_TASK_FAILED` —
 *    NEVER a random-UUID fallback, which would make `codex-reply` continue a
 *    thread that does not exist.
 *  - We do NOT treat `DSH_CODEX_*` markers inside user prompts as success: a
 *    call is successful iff the MCP result reports `isError !== true` AND the
 *    structured payload validates.
 *  - Without `structuredContent`, same strict rules apply to a top-level
 *    `content[].text` JSON that carries `threadId` (defensive for other codex
 *    builds); anything else is an error.
 */
export function parseToolOutput(result: unknown): CodexResult {
  const r = result as {
    isError?: unknown;
    structuredContent?: unknown;
    content?: { type?: unknown; text?: unknown }[];
  };
  if (r?.isError === true || r?.isError === "true") {
    throw new CodexCollabError(
      Codes.CODEX_TASK_FAILED,
      `codex MCP call returned an error: ${describeContent(r.content)}`,
    );
  }

  const sc = r?.structuredContent;
  if (sc !== undefined && sc !== null) {
    return parseStructured(sc);
  }

  // Defensive fallback: some builds surface threadId via content JSON.
  const text = extractText(r?.content);
  if (text) {
    try {
      const parsed = JSON.parse(text) as unknown;
      return parseStructured(parsed);
    } catch {
      /* not JSON; fall through to error */
    }
  }
  throw new CodexCollabError(
    Codes.CODEX_TASK_FAILED,
    `codex MCP call returned no valid structured threadId (got: ${describeContent(r?.content)})`,
  );
}

function parseStructured(sc: unknown): CodexResult {
  if (typeof sc !== "object" || sc === null) {
    throw new CodexCollabError(Codes.CODEX_TASK_FAILED, "codex MCP structuredContent is not an object");
  }
  const threadId = (sc as { threadId?: unknown }).threadId;
  const content = (sc as { content?: unknown }).content;
  if (typeof threadId !== "string" || threadId.trim().length === 0) {
    throw new CodexCollabError(
      Codes.CODEX_TASK_FAILED,
      `codex MCP structuredContent is missing a valid threadId string`,
    );
  }
  if (content !== undefined && typeof content !== "string") {
    throw new CodexCollabError(Codes.CODEX_TASK_FAILED, "codex MCP structuredContent.content must be a string");
  }
  return { threadId: threadId.trim(), content: typeof content === "string" ? content : "", ok: true };
}

function extractText(content: { type?: unknown; text?: unknown }[] | undefined): string {
  const parts = (content ?? [])
    .filter((c) => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string);
  return parts.join("\n");
}

function describeContent(content: { type?: unknown; text?: unknown }[] | undefined): string {
  const text = extractText(content);
  return text ? text.slice(0, 200) : "(no text)";
}
