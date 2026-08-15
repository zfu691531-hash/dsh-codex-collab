#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { dispatchDshTool, DSH_MCP_TOOLS } from "./codex-mcp-tools";
import { DshApiClient } from "./dsh-api";
import { DshTaskClient } from "./dsh-task-client";

function positiveEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

export function createDshMcpServer(tasks: DshTaskClient): Server {
  const server = new Server(
    { name: "dsh-codex-collab", version: "0.1.4" },
    {
      capabilities: { tools: {} },
      instructions:
        "Local collaboration bridge to DeepSeek Harness. Use dsh_task_start with agent_preset='cordis' for plugin development.",
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: DSH_MCP_TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      return await dispatchDshTool(tasks, request.params.name, request.params.arguments ?? {}, extra.signal);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text", text: message }], isError: true };
    }
  });
  return server;
}

export async function main(): Promise<void> {
  const api = new DshApiClient({
    baseUrl: process.env["DSH_BASE_URL"] ?? "http://127.0.0.1:3080",
    timeoutMs: positiveEnv("DSH_API_TIMEOUT_MS", 15_000),
  });
  const tasks = new DshTaskClient(api, {
    pollIntervalMs: positiveEnv("DSH_POLL_INTERVAL_MS", 250),
    taskTimeoutMs: positiveEnv("DSH_TASK_TIMEOUT_MS", 10 * 60 * 1000),
  });
  const server = createDshMcpServer(tasks);
  await server.connect(new StdioServerTransport());
}

const launchedDirectly = /(?:^|[\\/])codex-mcp-server\.(?:js|cjs)$/.test(process.argv[1] ?? "");
if (launchedDirectly) {
  main().catch((error) => {
    process.stderr.write(`[dsh-codex-collab] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
