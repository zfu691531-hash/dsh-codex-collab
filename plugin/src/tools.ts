import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { TaskManager } from "./task-manager";
import type { StatusProbe } from "./status";
import { clarificationForPrompt, isPromptIntegrityError } from "./prompt-integrity";

const REFERENCES_PARAMETER = {
  type: "array" as const,
  description: "HTTP(S) references preserved as structured collaboration inputs.",
  items: {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      uri: { type: "string" as const, required: true as const },
      title: { type: "string" as const },
      mediaType: { type: "string" as const },
    },
  },
};

const ARTIFACTS_PARAMETER = {
  type: "array" as const,
  description: "Absolute paths to local files/PDFs shared zero-copy on this machine.",
  items: {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      path: { type: "string" as const, required: true as const },
      name: { type: "string" as const },
      mediaType: { type: "string" as const },
    },
  },
};

const COLLABORATION_OUTPUT = {
  type: "object" as const,
  additionalProperties: false,
  properties: {
    taskId: { type: "string" as const },
    threadId: { type: "string" as const },
    sessionId: { type: "string" as const },
    content: { type: "string" as const, required: true as const },
    ok: { type: "boolean" as const, required: true as const },
    state: { type: "string" as const, enum: ["succeeded", "needs-clarification"] as const, required: true as const },
    recoverable: { type: "boolean" as const },
    code: { type: "string" as const },
    action: { type: "string" as const },
    message: {
      type: "object" as const,
      additionalProperties: false,
      properties: {
        text: { type: "string" as const, required: true as const },
        references: {
          type: "array" as const,
          required: true as const,
          items: {
            type: "object" as const,
            additionalProperties: false,
            properties: {
              uri: { type: "string" as const, required: true as const },
              title: { type: "string" as const },
              mediaType: { type: "string" as const },
              status: { type: "string" as const },
            },
          },
        },
        artifacts: {
          type: "array" as const,
          required: true as const,
          items: {
            type: "object" as const,
            additionalProperties: false,
            properties: {
              path: { type: "string" as const, required: true as const },
              name: { type: "string" as const },
              mediaType: { type: "string" as const, required: true as const },
              status: { type: "string" as const, required: true as const },
              sizeBytes: { type: "number" as const },
              modifiedAt: { type: "string" as const },
            },
          },
        },
      },
    },
    inputIssues: {
      type: "array" as const,
      items: {
        type: "object" as const,
        additionalProperties: false,
        properties: {
          code: { type: "string" as const, required: true as const },
          target: { type: "string" as const, required: true as const },
          index: { type: "integer" as const, required: true as const },
          message: { type: "string" as const, required: true as const },
          retryable: { type: "boolean" as const, required: true as const },
        },
      },
    },
  },
};

/**
 * Model-facing DSH tool surface over the TaskManager.
 * Names are stable and compact; schemas are strict (additionalProperties:false
 * on output, typed enums on permissions).
 */

export interface CodexTools {
  status: ToolDefinition;
  taskStart: ToolDefinition;
  taskReply: ToolDefinition;
}

export function createTools(manager: TaskManager, statusGetter?: () => StatusProbe): CodexTools {
  const status = defineTool({
    name: "codex_status",
    description:
      "Report whether the local Codex CLI / app-server is available, plus the current DSH-task ↔ Codex-thread mapping.",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          codexAvailable: { type: "boolean", required: true },
          version: { type: "string" },
          mcpServerHelpOk: { type: "boolean", required: true },
          resolved: { type: "string" },
          failures: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                path: { type: "string", required: true },
                reason: { type: "string", required: true },
              },
            },
          },
          backend: {
            type: "string",
            enum: ["app-server", "mcp", "fake", "unavailable"],
            required: true,
          },
          tasks: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                taskId: { type: "string", required: true },
                threadId: { type: "string", required: true },
                state: {
                  type: "string",
                  enum: ["running", "awaiting-reply", "done"],
                  required: true,
                },
                lastContent: { type: "string" },
              },
            },
          },
        },
      },
      render: (_args, value) => [
        {
          type: "text",
          text: [
            `codexAvailable: ${value.codexAvailable}`,
            value.version ? `version: ${value.version}` : "",
            `mcpServerHelpOk: ${value.mcpServerHelpOk}`,
            `backend: ${value.backend}`,
            value.resolved ? `resolved: ${value.resolved}` : "",
            value.failures.length > 0
              ? `failures:\n${value.failures.map((failure) => `  - ${failure.path}: ${failure.reason}`).join("\n")}`
              : "",
            value.tasks.length > 0
              ? `tasks:\n${value.tasks
                  .map(
                    (t) =>
                      `  - ${t.taskId} → thread ${t.threadId} [${t.state}]${t.lastContent ? ` "${t.lastContent.slice(0, 80)}"` : ""}`,
                  )
                  .join("\n")}`
              : "tasks: (none)",
          ]
            .filter((s) => s.length > 0)
            .join("\n"),
        },
      ],
      presentationMeta: (_args, value) => value,
    },
    isConcurrencySafe: () => true,
    async execute() {
      const probe = statusGetter?.();
      if (probe) {
        return {
          codexAvailable: probe.codexAvailable,
          version: probe.version,
          mcpServerHelpOk: probe.mcpServerHelpOk,
          resolved: probe.resolved || undefined,
          failures: probe.failures,
          backend: probe.codexAvailable ? manager.getBackendKind() : ("unavailable" as const),
          tasks: await manager.listTasks(),
        };
      }
      const report = await manager.probe();
      return {
        codexAvailable: report.codexAvailable,
        version: report.version,
        mcpServerHelpOk: report.mcpServerHelpOk,
        resolved: report.resolved,
        failures: report.failures,
        backend: report.backend,
        tasks: report.tasks,
      };
    },
  });

  const taskStart = defineTool({
    name: "codex_task_start",
    description:
      "Start a visible Codex Desktop task. Pass the current DSH workspace as absolute cwd whenever one exists; returns a saved DSH taskId plus the Codex threadId.",
    parameters: {
      prompt: { type: "string", required: true, description: "The task prompt for Codex." },
      references: REFERENCES_PARAMETER,
      artifacts: ARTIFACTS_PARAMETER,
      cwd: { type: "string", description: "Working directory for the Codex run (absolute path)." },
      approval_policy: {
        type: "string",
        enum: ["untrusted", "on-request", "never"],
        description: "Codex approval policy.",
      },
      sandbox: {
        type: "string",
        enum: ["read-only", "workspace-write", "danger-full-access"],
        description: "Codex sandbox mode.",
      },
      model: { type: "string", description: "Optional model override for the Codex run." },
    },
    output: {
      schema: COLLABORATION_OUTPUT,
      render: (_args, value) => [
        {
          type: "text",
          text: value.state === "needs-clarification"
            ? value.content
            : `task ${value.taskId} started (thread ${value.threadId})${value.ok ? "" : " — server did not ack"}\n${value.content}`,
        },
      ],
      presentationMeta: (_args, value) => value,
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const permissions = {
        ...(args.approval_policy ? { approvalPolicy: args.approval_policy } : {}),
        ...(args.sandbox ? { sandbox: args.sandbox } : {}),
      };
      try {
        const value = await manager.start({
          prompt: args.prompt,
          references: args.references,
          artifacts: args.artifacts,
          cwd: args.cwd,
          permissions,
          model: args.model,
        });
        return { ...value, state: "succeeded" as const };
      } catch (error) {
        if (isPromptIntegrityError(error)) return clarificationForPrompt(error);
        throw error;
      }
    },
  });

  const taskReply = defineTool({
    name: "codex_task_reply",
    description:
      "Continue a previously started Codex task by DSH taskId with a follow-up prompt; returns the (possibly unchanged) threadId.",
    parameters: {
      taskId: { type: "string", required: true, description: "DSH task id returned by codex_task_start." },
      prompt: { type: "string", required: true, description: "Follow-up prompt for Codex." },
      references: REFERENCES_PARAMETER,
      artifacts: ARTIFACTS_PARAMETER,
    },
    output: {
      schema: COLLABORATION_OUTPUT,
      render: (_args, value) => [
        { type: "text", text: value.state === "needs-clarification" ? value.content : `reply ok (thread ${value.threadId})${value.ok ? "" : " — server did not ack"}\n${value.content}` },
      ],
      presentationMeta: (_args, value) => value,
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      try {
        const value = await manager.reply(args.taskId, args.prompt, { references: args.references, artifacts: args.artifacts });
        return { ...value, taskId: args.taskId, state: "succeeded" as const };
      } catch (error) {
        if (isPromptIntegrityError(error)) return clarificationForPrompt(error, { taskId: args.taskId });
        throw error;
      }
    },
  });

  return { status, taskStart, taskReply };
}
