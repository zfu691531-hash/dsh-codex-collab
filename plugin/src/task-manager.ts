import { Codes, CodexCollabError, asCodexCollabError } from "./errors";
import type { CodexBackend, CodexResult, TaskPermissionOptions } from "./adapters/types";
import type { StoredTask, TaskStore } from "./store";
import { prepareCollaborationMessage, type CollaborationArtifactInput, type CollaborationInputIssue, type CollaborationMessageReceipt, type CollaborationReferenceInput } from "./collaboration-message";

export interface StatusReport {
  codexAvailable: boolean;
  version?: string;
  resolved?: string;
  mcpServerHelpOk: boolean;
  failures: { path: string; reason: string }[];
  tasks: StoredTask[];
  backend: "app-server" | "mcp" | "fake" | "unavailable";
}

export interface TaskManagerOptions {
  backend: CodexBackend;
  backendKind: "app-server" | "mcp" | "fake";
  store: TaskStore;
  /** Extra MCP start flags (excluding prompt/cwd/permissions/model). */
  startExtras?: Record<string, string | number | boolean>;
}

/**
 * Orchestrates DSH-side task lifecycle over a {@link CodexBackend}.
 * All failures degrade to stable {@link CodexCollabError}s; DSH startup never
 * depends on Codex being present.
 */
export class TaskManager {
  private readonly backend: CodexBackend;
  private readonly backendKind: TaskManagerOptions["backendKind"];
  private readonly store: TaskStore;
  private readonly startExtras: Record<string, string | number | boolean>;

  constructor(opts: TaskManagerOptions) {
    this.backend = opts.backend;
    this.backendKind = opts.backendKind;
    this.store = opts.store;
    this.startExtras = opts.startExtras ?? {};
  }

  /** Probe availability (soft; never throws). */
  async probe(): Promise<StatusReport> {
    let codexAvailable = false;
    let version: string | undefined;
    let resolved: string | undefined;
    let mcpServerHelpOk = false;
    try {
      await this.backend.connect();
      codexAvailable = true;
      resolved = this.backendKind === "mcp" || this.backendKind === "app-server" ? (this.backend as unknown as { executable?: string }).executable : undefined;
      mcpServerHelpOk = true;
    } catch {
      codexAvailable = false;
    }
    const tasks = await this.store.list();
    return {
      codexAvailable,
      version,
      resolved,
      mcpServerHelpOk,
      failures: [],
      tasks,
      backend: codexAvailable ? this.backendKind : "unavailable",
    };
  }

  /** Start a new Codex task and persist the mapping DSH-taskId ↔ Codex-threadId. */
  async start(request: {
    prompt: string;
    references?: CollaborationReferenceInput[];
    artifacts?: CollaborationArtifactInput[];
    cwd?: string;
    permissions?: TaskPermissionOptions;
    model?: string;
  }): Promise<CodexResult & { taskId: string; message: CollaborationMessageReceipt; inputIssues: CollaborationInputIssue[] }> {
    const prepared = await prepareCollaborationMessage({ text: request.prompt, references: request.references, artifacts: request.artifacts });
    let result: CodexResult;
    try {
      result = await this.backend.start({
        prompt: prepared.wireText,
        cwd: request.cwd,
        permissions: request.permissions,
        model: request.model,
        extra: this.startExtras,
      });
    } catch (error) {
      throw asCodexCollabError(error);
    }
    const stored = await this.store.create({
      ...(request.cwd ? { codexCwd: request.cwd } : {}),
      content: result.content,
      threadId: result.threadId,
    });
    return { ...result, taskId: stored.taskId, message: prepared.receipt, inputIssues: prepared.issues };
  }

  /** Continue an existing thread. Requires a known taskId in the store. */
  async reply(taskId: string, prompt: string, inputs: { references?: CollaborationReferenceInput[]; artifacts?: CollaborationArtifactInput[] } = {}): Promise<CodexResult & { message: CollaborationMessageReceipt; inputIssues: CollaborationInputIssue[] }> {
    const prepared = await prepareCollaborationMessage({ text: prompt, references: inputs.references, artifacts: inputs.artifacts });
    const session = await this.store.get(taskId);
    if (!session) {
      throw new CodexCollabError(Codes.THREAD_NOT_FOUND, `unknown task ${taskId}; start a task first`);
    }
    let result: CodexResult;
    try {
      result = await this.backend.reply({ threadId: session.threadId, prompt: prepared.wireText });
    } catch (error) {
      throw asCodexCollabError(error);
    }
    await this.store.recordReply(taskId, result.content);
    return { ...result, message: prepared.receipt, inputIssues: prepared.issues };
  }

  /** Shut down the backend (idempotent). */
  async close(): Promise<void> {
    await this.backend.close();
  }

  getBackendKind(): TaskManagerOptions["backendKind"] {
    return this.backendKind;
  }

  /** Enumerate the persisted DSH-task ↔ Codex-thread mapping. */
  async listTasks(): Promise<StoredTask[]> {
    return this.store.list();
  }
}
