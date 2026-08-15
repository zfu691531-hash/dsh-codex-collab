import { randomUUID } from "node:crypto";
import { Codes, CodexCollabError } from "./errors";
import type { CodexSession } from "./adapters/types";

export interface StoredTask extends CodexSession {
  taskId: string;
  codexCwd?: string;
}

/**
 * Replaceable mapping store: DSH task id ↔ Codex thread id.
 * Persistence is intentionally behind an interface so a later phase can back
 * it with the DSH storage service without touching tool code.
 */
export interface TaskStore {
  create(task: { codexCwd?: string; content: string; threadId: string }): Promise<StoredTask>;
  recordReply(taskId: string, content: string): Promise<void>;
  get(taskId: string): Promise<StoredTask | undefined>;
  list(): Promise<StoredTask[]>;
  clear(): Promise<void>;
}

function newSession(taskId: string, task: { codexCwd?: string; content: string; threadId: string }): StoredTask {
  return {
    taskId,
    threadId: task.threadId,
    state: "awaiting-reply",
    lastContent: task.content,
    ...(task.codexCwd ? { codexCwd: task.codexCwd } : {}),
  };
}

/** In-memory store; loses data on process restart (acceptable for V1, no global writes). */
export class InMemoryTaskStore implements TaskStore {
  private readonly sessions = new Map<string, StoredTask>();

  async create(task: { codexCwd?: string; content: string; threadId: string }): Promise<StoredTask> {
    const taskId = randomUUID();
    const stored = newSession(taskId, task);
    this.sessions.set(taskId, stored);
    return stored;
  }

  async recordReply(taskId: string, content: string): Promise<void> {
    const existing = this.sessions.get(taskId);
    if (!existing) {
      throw new CodexCollabError(Codes.THREAD_NOT_FOUND, `unknown task ${taskId}`);
    }
    this.sessions.set(taskId, { ...existing, lastContent: content });
  }

  async get(taskId: string): Promise<StoredTask | undefined> {
    return this.sessions.get(taskId);
  }

  async list(): Promise<StoredTask[]> {
    return [...this.sessions.values()];
  }

  async clear(): Promise<void> {
    this.sessions.clear();
  }
}
