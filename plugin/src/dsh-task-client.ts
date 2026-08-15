import {
  prepareCollaborationMessage,
  type CollaborationArtifactInput,
  type CollaborationInputIssue,
  type CollaborationMessageReceipt,
  type CollaborationReferenceInput,
} from "./collaboration-message";

export interface DshHistoryEvent {
  type: string;
  seq: number;
  time: number;
  data: unknown;
}

export interface DshHostApi {
  createSession(input: { cwd?: string; agentPreset?: string }, signal?: AbortSignal): Promise<{
    sessionId: string;
    agentPreset?: string;
  }>;
  prompt(sessionId: string, prompt: string, mode?: "queue" | "steer", signal?: AbortSignal): Promise<{ accepted: true }>;
  history(sessionId: string, signal?: AbortSignal): Promise<{
    events: Array<{ event: DshHistoryEvent }>;
    hasMore: boolean;
  }>;
  listSessions(signal?: AbortSignal): Promise<{
    items: Array<{ sessionId: string; running: boolean; blank: boolean; agentPreset?: string; cwd?: string }>;
  }>;
  cancel(sessionId: string, signal?: AbortSignal): Promise<{ accepted: true }>;
}

export type DshTaskState = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface DshTaskResult {
  taskId: string;
  sessionId: string;
  state: DshTaskState;
  ok: true;
  content?: string;
  turnEndReason?: string;
  agentPreset?: string;
  message?: CollaborationMessageReceipt;
  inputIssues?: CollaborationInputIssue[];
}

export interface DshTaskClientOptions {
  pollIntervalMs?: number;
  taskTimeoutMs?: number;
}

export class DshTaskError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DshTaskError";
    this.code = code;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function eventsOf(history: { events: Array<{ event: DshHistoryEvent }> }): DshHistoryEvent[] {
  return history.events.map(({ event }) => event);
}

function maxSeq(events: DshHistoryEvent[]): number {
  return events.reduce((max, event) => Math.max(max, event.seq), -1);
}

function turnNumber(event: DshHistoryEvent): number | undefined {
  const turn = record(event.data)?.turn;
  return typeof turn === "number" && Number.isInteger(turn) && turn > 0 ? turn : undefined;
}

function nextTurn(events: DshHistoryEvent[]): number {
  return events.reduce((max, event) => Math.max(max, turnNumber(event) ?? 0), 0) + 1;
}

function turnEndReason(event: DshHistoryEvent): string | undefined {
  if (event.type !== "turn/end") return undefined;
  const reason = record(record(event.data)?.reason);
  return typeof reason?.kind === "string" ? reason.kind : undefined;
}

function latestAssistantText(events: DshHistoryEvent[], afterSeq = -1): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || event.seq <= afterSeq || event.type !== "assistant/message") continue;
    const message = record(record(event.data)?.message);
    const content = message?.content;
    if (!Array.isArray(content)) continue;
    const text = content
      .map((block) => record(block))
      .filter((block): block is Record<string, unknown> => block?.type === "text" && typeof block.text === "string")
      .map((block) => String(block.text))
      .join("")
      .trim();
    if (text) return text;
  }
  return undefined;
}

function stateFor(reason: string | undefined, running: boolean): DshTaskState {
  if (running) return "running";
  if (!reason) return "queued";
  if (reason === "completed") return "succeeded";
  if (reason === "aborted") return "cancelled";
  return "failed";
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Task semantics over the official DSH session Host API. */
export class DshTaskClient {
  private readonly api: DshHostApi;
  private readonly pollIntervalMs: number;
  private readonly taskTimeoutMs: number;

  constructor(api: DshHostApi, options: DshTaskClientOptions = {}) {
    this.api = api;
    this.pollIntervalMs = options.pollIntervalMs ?? 250;
    this.taskTimeoutMs = options.taskTimeoutMs ?? 10 * 60 * 1000;
  }

  async start(input: {
    prompt: string;
    references?: CollaborationReferenceInput[];
    artifacts?: CollaborationArtifactInput[];
    cwd?: string;
    agentPreset?: string;
    wait?: boolean;
  }, signal?: AbortSignal): Promise<DshTaskResult> {
    const prepared = await prepareCollaborationMessage({ text: input.prompt, references: input.references, artifacts: input.artifacts });
    const created = await this.api.createSession(
      { ...(input.cwd ? { cwd: input.cwd } : {}), ...(input.agentPreset ? { agentPreset: input.agentPreset } : {}) },
      signal,
    );
    const baselineEvents = eventsOf(await this.api.history(created.sessionId, signal));
    const baseline = maxSeq(baselineEvents);
    const expectedTurn = nextTurn(baselineEvents);
    await this.api.prompt(created.sessionId, prepared.wireText, "queue", signal);
    if (input.wait === false) {
      return {
        taskId: created.sessionId,
        sessionId: created.sessionId,
        state: "running",
        ok: true,
        message: prepared.receipt,
        inputIssues: prepared.issues,
        ...(created.agentPreset ? { agentPreset: created.agentPreset } : {}),
      };
    }
    const result = await this.waitForTurn(created.sessionId, baseline, expectedTurn, signal);
    return {
      ...result,
      message: prepared.receipt,
      inputIssues: prepared.issues,
      ...(created.agentPreset ? { agentPreset: created.agentPreset } : {}),
    };
  }

  async reply(input: { taskId: string; prompt: string; references?: CollaborationReferenceInput[]; artifacts?: CollaborationArtifactInput[]; wait?: boolean }, signal?: AbortSignal): Promise<DshTaskResult> {
    const prepared = await prepareCollaborationMessage({ text: input.prompt, references: input.references, artifacts: input.artifacts });
    const baselineEvents = eventsOf(await this.api.history(input.taskId, signal));
    const baseline = maxSeq(baselineEvents);
    const expectedTurn = nextTurn(baselineEvents);
    await this.api.prompt(input.taskId, prepared.wireText, "queue", signal);
    if (input.wait === false) return {
      taskId: input.taskId,
      sessionId: input.taskId,
      state: "running",
      ok: true,
      message: prepared.receipt,
      inputIssues: prepared.issues,
    };
    const result = await this.waitForTurn(input.taskId, baseline, expectedTurn, signal);
    return { ...result, message: prepared.receipt, inputIssues: prepared.issues };
  }

  async status(taskId: string, signal?: AbortSignal): Promise<DshTaskResult> {
    const [sessions, history] = await Promise.all([this.api.listSessions(signal), this.api.history(taskId, signal)]);
    const summary = sessions.items.find((item) => item.sessionId === taskId);
    if (!summary) throw new DshTaskError("DSH_TASK_NOT_FOUND", `unknown DSH task/session ${taskId}`);
    const events = eventsOf(history);
    const end = [...events].reverse().find((event) => event.type === "turn/end");
    const reason = end ? turnEndReason(end) : undefined;
    const content = latestAssistantText(events);
    return {
      taskId,
      sessionId: taskId,
      state: stateFor(reason, summary.running),
      ok: true,
      ...(content ? { content } : {}),
      ...(reason ? { turnEndReason: reason } : {}),
      ...(summary.agentPreset ? { agentPreset: summary.agentPreset } : {}),
    };
  }

  async cancel(taskId: string, signal?: AbortSignal): Promise<DshTaskResult> {
    await this.api.cancel(taskId, signal);
    return { taskId, sessionId: taskId, state: "cancelled", ok: true };
  }

  private async waitForTurn(
    taskId: string,
    baselineSeq: number,
    expectedTurn: number,
    signal?: AbortSignal,
  ): Promise<DshTaskResult> {
    const deadline = Date.now() + this.taskTimeoutMs;
    while (Date.now() <= deadline) {
      const events = eventsOf(await this.api.history(taskId, signal));
      const end = events.find(
        (event) => event.seq > baselineSeq && event.type === "turn/end" && turnNumber(event) === expectedTurn,
      );
      if (end) {
        const reason = turnEndReason(end);
        const content = latestAssistantText(events, baselineSeq);
        return {
          taskId,
          sessionId: taskId,
          state: stateFor(reason, false),
          ok: true,
          ...(content ? { content } : {}),
          ...(reason ? { turnEndReason: reason } : {}),
        };
      }
      await delay(this.pollIntervalMs, signal);
    }
    throw new DshTaskError("DSH_TASK_TIMEOUT", `DSH task ${taskId} did not finish within ${this.taskTimeoutMs}ms`);
  }
}
