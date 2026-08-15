import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { DshTaskClient, DshTaskResult } from "./dsh-task-client";
import type { CollaborationArtifactInput, CollaborationReferenceInput } from "./collaboration-message";
import { assertPromptIntegrity, clarificationForPrompt, isPromptIntegrityError, type CollaborationClarification } from "./prompt-integrity";

const RESULT_SCHEMA: NonNullable<Tool["outputSchema"]> = {
  type: "object",
  additionalProperties: false,
  properties: {
    taskId: { type: "string" },
    sessionId: { type: "string" },
    state: { type: "string", enum: ["queued", "running", "succeeded", "failed", "cancelled", "needs-clarification"] },
    ok: { type: "boolean" },
    content: { type: "string" },
    turnEndReason: { type: "string" },
    agentPreset: { type: "string" },
    recoverable: { type: "boolean" },
    code: { type: "string" },
    action: { type: "string" },
    message: {
      type: "object",
      additionalProperties: false,
      properties: {
        text: { type: "string" },
        references: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              uri: { type: "string" }, title: { type: "string" }, mediaType: { type: "string" }, status: { type: "string" },
            },
            required: ["uri"],
          },
        },
        artifacts: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              path: { type: "string" }, name: { type: "string" }, mediaType: { type: "string" }, status: { type: "string" },
              sizeBytes: { type: "number" }, modifiedAt: { type: "string" },
            },
            required: ["path", "mediaType", "status"],
          },
        },
      },
      required: ["text", "references", "artifacts"],
    },
    inputIssues: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          code: { type: "string" }, target: { type: "string" }, index: { type: "number" }, message: { type: "string" }, retryable: { type: "boolean" },
        },
        required: ["code", "target", "index", "message", "retryable"],
      },
    },
  },
  required: ["state", "ok"],
};

const REFERENCE_INPUT_SCHEMA = {
  type: "array" as const,
  items: {
    type: "object" as const,
    additionalProperties: false,
    properties: { uri: { type: "string" as const }, title: { type: "string" as const }, mediaType: { type: "string" as const } },
    required: ["uri"],
  },
};

const ARTIFACT_INPUT_SCHEMA = {
  type: "array" as const,
  items: {
    type: "object" as const,
    additionalProperties: false,
    properties: { path: { type: "string" as const }, name: { type: "string" as const }, mediaType: { type: "string" as const } },
    required: ["path"],
  },
};

export const DSH_MCP_TOOLS: Tool[] = [
  {
    name: "dsh_task_start",
    description:
      "Create a local DeepSeek Harness task/session and send its first prompt. Use agent_preset='cordis' for DSH plugin or agent-preset development (creator mode).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        prompt: { type: "string", description: "Task instruction for DSH." },
        references: { ...REFERENCE_INPUT_SCHEMA, description: "HTTP(S) references that must remain structured when agents forward the task." },
        artifacts: { ...ARTIFACT_INPUT_SCHEMA, description: "Absolute paths to local files/PDFs shared zero-copy on this machine." },
        cwd: { type: "string", description: "Absolute DSH workspace directory." },
        agent_preset: { type: "string", description: "DSH preset id; creator mode is 'cordis'." },
        wait: { type: "boolean", description: "Wait for the DSH turn result (default true)." },
      },
      required: ["prompt"],
    },
    outputSchema: RESULT_SCHEMA,
  },
  {
    name: "dsh_task_reply",
    description: "Continue an existing DSH collaboration task using the session/task id returned by dsh_task_start.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        taskId: { type: "string" },
        prompt: { type: "string" },
        references: REFERENCE_INPUT_SCHEMA,
        artifacts: ARTIFACT_INPUT_SCHEMA,
        wait: { type: "boolean", description: "Wait for the DSH turn result (default true)." },
      },
      required: ["taskId", "prompt"],
    },
    outputSchema: RESULT_SCHEMA,
  },
  {
    name: "dsh_task_status",
    description: "Read current state and latest visible assistant response for a DSH collaboration task.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { taskId: { type: "string" } },
      required: ["taskId"],
    },
    outputSchema: RESULT_SCHEMA,
  },
  {
    name: "dsh_task_cancel",
    description: "Cancel the active turn of a DSH collaboration task.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { taskId: { type: "string" } },
      required: ["taskId"],
    },
    outputSchema: RESULT_SCHEMA,
  },
];

function objectArgs(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("tool arguments must be an object");
  return value as Record<string, unknown>;
}

function requiredString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${name} is required and must be a non-empty string`);
  return value;
}

function requiredPrompt(args: Record<string, unknown>): string {
  return assertPromptIntegrity(requiredString(args, "prompt"));
}

function optionalRecords(args: Record<string, unknown>, name: string): Record<string, unknown>[] | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "object" || item === null || Array.isArray(item))) {
    throw new Error(`${name} must be an array of objects`);
  }
  return value as Record<string, unknown>[];
}

function optionalReferences(args: Record<string, unknown>): CollaborationReferenceInput[] | undefined {
  return optionalRecords(args, "references")?.map((item) => ({
    uri: requiredString(item, "uri"),
    ...(optionalString(item, "title") !== undefined ? { title: optionalString(item, "title") } : {}),
    ...(optionalString(item, "mediaType") !== undefined ? { mediaType: optionalString(item, "mediaType") } : {}),
  }));
}

function optionalArtifacts(args: Record<string, unknown>): CollaborationArtifactInput[] | undefined {
  return optionalRecords(args, "artifacts")?.map((item) => ({
    path: requiredString(item, "path"),
    ...(optionalString(item, "name") !== undefined ? { name: optionalString(item, "name") } : {}),
    ...(optionalString(item, "mediaType") !== undefined ? { mediaType: optionalString(item, "mediaType") } : {}),
  }));
}

function optionalString(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}

function optionalBoolean(args: Record<string, unknown>, name: string): boolean | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  return value;
}

function result(value: DshTaskResult): CallToolResult {
  const summary = [`DSH task ${value.taskId}: ${value.state}`, value.content ?? ""].filter(Boolean).join("\n");
  return { content: [{ type: "text", text: summary }], structuredContent: { ...value } };
}

function clarification(value: CollaborationClarification): CallToolResult {
  return { content: [{ type: "text", text: value.content }], structuredContent: { ...value } };
}

export async function dispatchDshTool(
  tasks: DshTaskClient,
  name: string,
  rawArgs: unknown,
  signal?: AbortSignal,
): Promise<CallToolResult> {
  const args = objectArgs(rawArgs);
  switch (name) {
    case "dsh_task_start": {
      let prompt: string;
      try {
        prompt = requiredPrompt(args);
      } catch (error) {
        if (isPromptIntegrityError(error)) return clarification(clarificationForPrompt(error));
        throw error;
      }
      return result(
        await tasks.start(
          {
            prompt,
            references: optionalReferences(args),
            artifacts: optionalArtifacts(args),
            cwd: optionalString(args, "cwd"),
            agentPreset: optionalString(args, "agent_preset"),
            wait: optionalBoolean(args, "wait"),
          },
          signal,
        ),
      );
    }
    case "dsh_task_reply": {
      const taskId = requiredString(args, "taskId");
      let prompt: string;
      try {
        prompt = requiredPrompt(args);
      } catch (error) {
        if (isPromptIntegrityError(error)) return clarification(clarificationForPrompt(error, { taskId, sessionId: taskId }));
        throw error;
      }
      return result(
        await tasks.reply(
          {
            taskId,
            prompt,
            references: optionalReferences(args),
            artifacts: optionalArtifacts(args),
            wait: optionalBoolean(args, "wait"),
          },
          signal,
        ),
      );
    }
    case "dsh_task_status":
      return result(await tasks.status(requiredString(args, "taskId"), signal));
    case "dsh_task_cancel":
      return result(await tasks.cancel(requiredString(args, "taskId"), signal));
    default:
      throw new Error(`unknown tool ${name}`);
  }
}
