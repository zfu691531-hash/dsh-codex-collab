import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { Codes, CodexCollabError, type Code } from "../errors";
import { assertUtf8TransportIntegrity } from "../prompt-integrity";
import type {
  CodexApprovalPolicy,
  CodexBackend,
  CodexReplyRequest,
  CodexResult,
  CodexSandboxMode,
  CodexStartRequest,
} from "./types";

export interface AppServerBackendOptions {
  executable: string;
  taskTimeoutMs: number;
  connectTimeoutMs: number;
  keepAlive: boolean;
  defaultApprovalPolicy?: CodexApprovalPolicy;
  defaultSandbox?: CodexSandboxMode;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

interface ProtocolMessage {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

interface NotificationWaiter {
  method: string;
  predicate(message: ProtocolMessage): boolean;
  resolve(message: ProtocolMessage): void;
  reject(error: unknown): void;
  timer: NodeJS.Timeout;
}

/**
 * Official Codex app-server JSONL backend.
 *
 * Unlike `codex mcp-server`, app-server creates interactive Codex threads.
 * Those threads participate in the desktop app's default task list, so a task
 * delegated by DSH is visible and can be continued from Codex Desktop.
 */
export class AppServerBackend implements CodexBackend {
  readonly executable: string;
  private readonly opts: AppServerBackendOptions;
  private child: ChildProcessWithoutNullStreams | undefined;
  private lines: ReadlineInterface | undefined;
  private connected = false;
  private closed = false;
  private connecting: Promise<void> | undefined;
  private nextId = 1;
  private readonly pending = new Map<number | string, PendingRequest>();
  private readonly notifications: ProtocolMessage[] = [];
  private readonly waiters = new Set<NotificationWaiter>();
  private readonly stderrTail: string[] = [];

  constructor(opts: AppServerBackendOptions) {
    this.opts = opts;
    this.executable = opts.executable;
  }

  async connect(): Promise<void> {
    if (this.closed) throw new CodexCollabError(Codes.CODEX_UNAVAILABLE, "backend already closed");
    if (this.connected) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.connectOnce().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async connectOnce(): Promise<void> {
    try {
      const child = spawn(this.opts.executable, ["app-server", "--listen", "stdio://"], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        ...(this.opts.cwd ? { cwd: this.opts.cwd } : {}),
        ...(this.opts.env ? { env: cleanEnvironment(this.opts.env) } : {}),
      });
      this.child = child;
      this.lines = createInterface({ input: child.stdout });
      this.lines.on("line", (line) => this.onLine(line));
      child.stderr.on("data", (chunk: Buffer) => this.rememberStderr(chunk.toString("utf8")));
      child.once("error", (error) => this.onExit(error));
      child.once("exit", (code, signal) => {
        if (this.child === child) this.onExit(new Error(`codex app-server exited (code ${String(code)}, signal ${String(signal)})`));
      });

      await withTimeout(
        this.request("initialize", {
          clientInfo: { name: "dsh_codex_collab", title: "DSH Codex Collab", version: "0.1.4" },
        }),
        this.opts.connectTimeoutMs,
        `codex app-server did not become ready within ${this.opts.connectTimeoutMs}ms`,
      );
      this.notify("initialized", {});
      this.connected = true;
    } catch (error) {
      await this.disconnect();
      if (error instanceof CodexCollabError) throw error;
      throw new CodexCollabError(
        Codes.CODEX_UNAVAILABLE,
        `failed to connect to codex app-server: ${error instanceof Error ? error.message : String(error)}${this.stderrDetail()}`,
        { cause: error },
      );
    }
  }

  async start(request: CodexStartRequest): Promise<CodexResult> {
    const prompt = assertUtf8TransportIntegrity(request.prompt);
    await this.connect();
    try {
      const permissions = request.permissions ?? {};
      const result = await this.request("thread/start", {
        ...(request.cwd || this.opts.cwd ? { cwd: request.cwd ?? this.opts.cwd } : {}),
        approvalPolicy: permissions.approvalPolicy ?? this.opts.defaultApprovalPolicy ?? "never",
        sandbox: permissions.sandbox ?? this.opts.defaultSandbox ?? "workspace-write",
        ...(request.model ? { model: request.model } : {}),
        serviceName: "dsh-codex-collab",
      }) as { thread?: { id?: unknown } };
      const threadId = result?.thread?.id;
      if (typeof threadId !== "string" || !threadId) {
        throw new CodexCollabError(Codes.CODEX_TASK_FAILED, "codex app-server thread/start returned no thread id");
      }
      return await this.runTurn(threadId, prompt);
    } finally {
      if (!this.opts.keepAlive) await this.disconnect();
    }
  }

  async reply(request: CodexReplyRequest): Promise<CodexResult> {
    const prompt = assertUtf8TransportIntegrity(request.prompt);
    await this.connect();
    try {
      await this.request("thread/resume", { threadId: request.threadId });
      return await this.runTurn(request.threadId, prompt);
    } catch (error) {
      if (error instanceof CodexCollabError) throw error;
      throw new CodexCollabError(Codes.CODEX_TASK_FAILED, `could not resume Codex thread ${request.threadId}: ${describeError(error)}`, { cause: error });
    } finally {
      if (!this.opts.keepAlive) await this.disconnect();
    }
  }

  private async runTurn(threadId: string, prompt: string): Promise<CodexResult> {
    try {
      const notificationStart = this.notifications.length;
      const started = await this.request("turn/start", {
        threadId,
        input: [{ type: "text", text: prompt }],
      }) as { turn?: { id?: unknown } };
      const turnId = typeof started?.turn?.id === "string" ? started.turn.id : undefined;
      const completed = await this.waitFor(
        "turn/completed",
        (message) => message.params?.threadId === threadId && (!turnId || (message.params?.turn as { id?: unknown } | undefined)?.id === turnId),
        this.opts.taskTimeoutMs,
      );
      const turn = completed.params?.turn as { status?: unknown; error?: unknown } | undefined;
      if (turn?.status === "failed") {
        throw new CodexCollabError(Codes.CODEX_TASK_FAILED, `Codex turn failed: ${JSON.stringify(turn.error ?? "unknown error")}`);
      }
      const content = this.agentText(threadId, turnId, notificationStart);
      return { threadId, content, ok: true };
    } catch (error) {
      if (error instanceof CodexCollabError) throw error;
      throw new CodexCollabError(Codes.CODEX_TASK_FAILED, `codex app-server turn failed: ${describeError(error)}${this.stderrDetail()}`, { cause: error });
    }
  }

  private agentText(threadId: string, turnId: string | undefined, notificationStart: number): string {
    return this.notifications
      .slice(notificationStart)
      .filter((message) => message.method === "item/completed" && message.params?.threadId === threadId && (!turnId || !message.params?.turnId || message.params.turnId === turnId))
      .map((message) => message.params?.item as { type?: unknown; text?: unknown } | undefined)
      .filter((item) => item?.type === "agentMessage" && typeof item.text === "string")
      .map((item) => item!.text as string)
      .join("\n");
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.send({ id, method, params });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.send({ method, params });
  }

  private send(message: ProtocolMessage): void {
    if (!this.child?.stdin.writable) throw new CodexCollabError(Codes.CODEX_UNAVAILABLE, "codex app-server stdin is not writable");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private onLine(line: string): void {
    let message: ProtocolMessage;
    try {
      message = JSON.parse(line) as ProtocolMessage;
    } catch {
      this.rememberStderr(`invalid app-server JSONL: ${line}`);
      return;
    }
    if (message.id !== undefined && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id)!;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      else pending.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) {
      // Interactive approvals/questions are intentionally not bridged yet.
      this.send({ id: message.id, error: { code: -32601, message: `unsupported server request: ${message.method}` } });
      return;
    }
    this.notifications.push(message);
    for (const waiter of [...this.waiters]) {
      if (waiter.method === message.method && waiter.predicate(message)) {
        clearTimeout(waiter.timer);
        this.waiters.delete(waiter);
        waiter.resolve(message);
      }
    }
  }

  private waitFor(method: string, predicate: (message: ProtocolMessage) => boolean, timeoutMs: number): Promise<ProtocolMessage> {
    const existing = this.notifications.find((message) => message.method === method && predicate(message));
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = {} as NotificationWaiter;
      waiter.method = method;
      waiter.predicate = predicate;
      waiter.resolve = resolve;
      waiter.reject = reject;
      waiter.timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new CodexCollabError(Codes.CODEX_TASK_FAILED, `timed out waiting for ${method} after ${timeoutMs}ms`));
      }, timeoutMs);
      this.waiters.add(waiter);
    });
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
    const child = this.child;
    this.connected = false;
    this.child = undefined;
    this.lines?.close();
    this.lines = undefined;
    if (child) {
      child.stdin.end();
      child.kill("SIGTERM");
    }
    this.rejectAll(new CodexCollabError(Codes.CODEX_UNAVAILABLE, "codex app-server disconnected"));
  }

  private onExit(error: Error): void {
    this.connected = false;
    this.child = undefined;
    this.lines?.close();
    this.lines = undefined;
    this.rejectAll(new CodexCollabError(Codes.CODEX_UNAVAILABLE, `${error.message}${this.stderrDetail()}`, { cause: error }));
  }

  private rejectAll(error: CodexCollabError): void {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters.clear();
  }

  private rememberStderr(text: string): void {
    for (const line of text.split(/\r?\n/u).filter(Boolean)) this.stderrTail.push(line);
    if (this.stderrTail.length > 20) this.stderrTail.splice(0, this.stderrTail.length - 20);
  }

  private stderrDetail(): string {
    return this.stderrTail.length ? `\napp-server stderr:\n${this.stderrTail.join("\n")}` : "";
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string, code: Code = Codes.CODEX_UNAVAILABLE): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new CodexCollabError(code, message)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function cleanEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
