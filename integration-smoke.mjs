import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { discoverDshBaseUrl } from "./launch-dsh-collab.mjs";

const mode = process.argv[2] ?? "direct";
const customPrompt = process.argv.slice(3).join(" ").trim();
if (!new Set(["direct", "roundtrip", "ask"]).has(mode) || (mode === "ask" && !customPrompt)) {
  throw new Error("usage: node integration-smoke.mjs <direct|roundtrip|ask> [prompt]");
}

const dshRoot = process.env.DSH_HOME ?? `${process.env.HOME}/.dsh`;
const profile = process.env.DSH_PROFILE ?? "web";
const nodePath = process.execPath;
const installedRoot = `${dshRoot}/profiles/${profile}/node_modules/dsh-codex-collab`;
const serverPath = `${installedRoot}/dist/codex-mcp-server.js`;
const launcherPath = `${dshRoot}/packages/dsh-codex-collab/launch-dsh-collab.mjs`;

const prompts = {
  direct: [
    "这是 Codex → DSH 协作链路验收。",
    "不要调用任何工具，不要修改文件。",
    "请只回复以下文本，不要添加其他内容：CODEX_TO_DSH_OK",
  ].join("\n"),
  roundtrip: [
    "这是 DSH → Codex 协作链路验收。",
    "你必须先调用 codex_status，然后调用 codex_task_start。",
    `调用 codex_task_start 时把 cwd 设置为 ${process.cwd()}。`,
    "传给 Codex 的任务是：不要调用工具，不要修改文件，只回复 CODEX_WORKER_OK。",
    "等待 Codex 返回后，只回复：DSH_TO_CODEX_OK CODEX_WORKER_OK",
  ].join("\n"),
  ask: customPrompt,
};

const child = spawn(nodePath, [launcherPath, serverPath], {
  cwd: installedRoot,
  env: { ...process.env, DSH_BASE_URL: "auto" },
  stdio: ["pipe", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
const pending = new Map();

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function request(id, method, params = {}) {
  return new Promise((resolveRequest, rejectRequest) => {
    pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
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

async function dshCall(baseUrl, method, payload) {
  const rpcId = randomUUID();
  const response = await fetch(new URL(`/api/${method}`, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ type: "client-request", rpcId, method, payload }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`DSH ${method} returned HTTP ${response.status}`);
  const body = await response.json();
  if (body?.type !== "server-response" || body?.rpcId !== rpcId || body?.result?.ok !== true) {
    throw new Error(`Invalid DSH ${method} response: ${JSON.stringify(body)}`);
  }
  return body.result.value;
}

const timeout = setTimeout(() => {
  for (const waiter of pending.values()) waiter.reject(new Error(`INTEGRATION_TIMEOUT: ${stderr}`));
  pending.clear();
  child.kill();
}, 11 * 60_000);

try {
  await request(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "dsh-codex-collab-integration", version: "0.1.0" },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  const result = await request(2, "tools/call", {
    name: "dsh_task_start",
    arguments: {
      prompt: prompts[mode],
      agent_preset: "standard",
      cwd: process.cwd(),
      wait: true,
    },
  });
  if (result?.isError) throw new Error(result.content?.map((item) => item.text ?? "").join("\n") || "MCP tool failed");
  const structured = result?.structuredContent ?? {};
  const content = typeof structured.content === "string"
    ? structured.content
    : result?.content?.map((item) => item.text ?? "").join("\n") ?? "";
  const expected = mode === "direct" ? "CODEX_TO_DSH_OK" : mode === "roundtrip" ? "DSH_TO_CODEX_OK CODEX_WORKER_OK" : "";
  if (expected && !content.includes(expected)) {
    throw new Error(`Expected ${expected}, got: ${content}`);
  }

  const sessionId = structured.sessionId ?? structured.taskId;
  let toolObserved = mode !== "roundtrip";
  if (sessionId && mode === "roundtrip") {
    const baseUrl = await discoverDshBaseUrl();
    const history = await dshCall(baseUrl, "session.history", { sessionId, maxMessages: 64 });
    toolObserved = JSON.stringify(history).includes("codex_task_start");
  }
  if (!toolObserved) throw new Error("DSH completed, but codex_task_start was not observed in session history");

  const label = mode === "direct" ? "CODEX_TO_DSH_INTEGRATION_OK" : mode === "roundtrip" ? "DSH_TO_CODEX_INTEGRATION_OK" : "DSH_ANSWER_OK";
  process.stdout.write(`${label}\n`);
  process.stdout.write(`sessionId: ${sessionId ?? "unknown"}\n`);
  process.stdout.write(`content: ${content}\n`);
} finally {
  clearTimeout(timeout);
  child.stdin.end();
  child.kill();
}
