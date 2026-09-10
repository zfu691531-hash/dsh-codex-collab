import { spawn } from "node:child_process";

const [nodePath, serverPath, cwd, baseUrl = "http://127.0.0.1:3080", launcherPath] = process.argv.slice(2);
const liveTask = process.env.DSH_SMOKE_TASK === "1";
if (!nodePath || !serverPath || !cwd) {
  throw new Error("usage: mcp-smoke.mjs <node> <server> <cwd> [baseUrl]");
}

const child = spawn(nodePath, launcherPath ? [launcherPath, serverPath] : [serverPath], {
  cwd,
  env: { ...process.env, DSH_BASE_URL: baseUrl },
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});

let stdout = "";
let stderr = "";
const pending = new Map();

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function request(id, method, params = {}) {
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

function consume() {
  let newline;
  while ((newline = stdout.indexOf("\n")) >= 0) {
    const line = stdout.slice(0, newline).replace(/\r$/u, "");
    stdout = stdout.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.id === undefined) continue;
    const waiter = pending.get(message.id);
    if (!waiter) continue;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
    else waiter.resolve(message.result);
  }
}

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdout += chunk;
  consume();
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

const timeout = setTimeout(() => {
  for (const waiter of pending.values()) waiter.reject(new Error(`MCP_SMOKE_TIMEOUT: ${stderr}`));
  pending.clear();
  child.kill();
}, liveTask ? 180_000 : 15_000);

try {
  await request(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "dsh-codex-collab-doctor", version: "0.1.0" },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  const listed = await request(2, "tools/list");
  const names = listed.tools.map((tool) => tool.name).sort();
  const expected = ["dsh_task_cancel", "dsh_task_reply", "dsh_task_start", "dsh_task_status"];
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error(`MCP_TOOL_MISMATCH: ${JSON.stringify(names)}`);
  }
  process.stdout.write(`MCP_COMPANION_OK ${names.join(",")}\n`);
  if (liveTask) {
    const started = await request(3, "tools/call", {
      name: "dsh_task_start",
      arguments: { prompt: "Do not use tools or modify files. Reply with only DSH_AUTH_TASK_OK", cwd: process.cwd(), wait: true },
    });
    if (started.isError || !JSON.stringify(started).includes("DSH_AUTH_TASK_OK")) throw new Error(`DSH live task failed: ${JSON.stringify(started)}`);
    const taskId = started.structuredContent?.taskId;
    if (!taskId) throw new Error("DSH task did not return taskId");
    const replied = await request(4, "tools/call", {
      name: "dsh_task_reply", arguments: { taskId, prompt: "Do not use tools. Reply with only DSH_AUTH_REPLY_OK", wait: true },
    });
    if (replied.isError || !JSON.stringify(replied).includes("DSH_AUTH_REPLY_OK")) throw new Error(`DSH live reply failed: ${JSON.stringify(replied)}`);
    const status = await request(5, "tools/call", { name: "dsh_task_status", arguments: { taskId } });
    if (status.isError || !JSON.stringify(status).includes("DSH_AUTH_REPLY_OK")) throw new Error(`DSH live status failed: ${JSON.stringify(status)}`);
    process.stdout.write("DSH_AUTH_MCP_TASK_OK start,reply,status\n");
  }
} finally {
  clearTimeout(timeout);
  child.stdin.end();
  child.kill();
}
