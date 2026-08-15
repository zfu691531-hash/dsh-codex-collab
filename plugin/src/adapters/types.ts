export type CodexApprovalPolicy = "untrusted" | "on-request" | "never";
export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export interface TaskPermissionOptions {
  approvalPolicy?: CodexApprovalPolicy;
  sandbox?: CodexSandboxMode;
}

export interface CodexStartRequest {
  prompt: string;
  cwd?: string;
  permissions?: TaskPermissionOptions;
  model?: string;
  extra?: Record<string, string | number | boolean>;
}

export interface CodexReplyRequest {
  threadId: string;
  prompt: string;
}

export interface CodexResult {
  threadId: string;
  content: string;
  ok: boolean;
}

export interface CodexSession {
  threadId: string;
  state: "running" | "awaiting-reply" | "done";
  lastContent?: string;
}

export interface CodexBackend {
  connect(): Promise<void>;
  start(request: CodexStartRequest): Promise<CodexResult>;
  reply(request: CodexReplyRequest): Promise<CodexResult>;
  available(): boolean;
  close(): Promise<void>;
}
