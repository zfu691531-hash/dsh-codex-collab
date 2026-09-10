import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function assertLoopbackBase(raw) {
  const url = new URL(raw);
  const host = url.hostname.toLowerCase();
  const loopback = host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
  if (url.protocol !== "http:" || !loopback) {
    throw new Error("DSH base URL must be an HTTP loopback address");
  }
  url.pathname = url.pathname.replace(/\/$/u, "");
  return url.href;
}

async function probeDsh(baseUrl) {
  const rpcId = `dsh-collab-probe-${Date.now()}`;
  try {
    const response = await fetch(new URL("/api/session.list", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ type: "client-request", rpcId, method: "session.list", payload: {} }),
      signal: AbortSignal.timeout(1500),
      redirect: "manual",
    });
    if (response.status === 401) {
      const message = (await response.text()).trim();
      return message === "unauthorized" || message === "dsh web authentication required; reopen the URL printed by dsh web.";
    }
    if (!response.ok) return false;
    const body = await response.json();
    return body?.type === "server-response" && body?.rpcId === rpcId;
  } catch {
    return false;
  }
}

async function dshHostPids() {
  const { stdout } = await execFileAsync("/bin/ps", ["-axo", "pid=,command="], { maxBuffer: 4 * 1024 * 1024 });
  return stdout
    .split(/\r?\n/u)
    .map((line) => line.match(/^\s*(\d+)\s+(.+)$/u))
    .filter((match) => match && /@deepseek-ai\/dsh\/lib\/bin\.js/u.test(match[2]) && /--host\s+127\.0\.0\.1/u.test(match[2]))
    .map((match) => Number(match[1]));
}

async function listeningPorts(pid) {
  const lsofCandidates = ["/usr/sbin/lsof", "/usr/bin/lsof"];
  let lsofPath;
  for (const candidate of lsofCandidates) {
    try {
      await access(candidate);
      lsofPath = candidate;
      break;
    } catch {
      // Try the next standard macOS location.
    }
  }
  if (!lsofPath) throw new Error("LSOF_NOT_FOUND: cannot discover the DeepSeek Harness Host port");
  const { stdout } = await execFileAsync(lsofPath, ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-Fn"]);
  return stdout
    .split(/\r?\n/u)
    .map((line) => line.match(/^n127\.0\.0\.1:(\d+)$/u))
    .filter(Boolean)
    .map((match) => Number(match[1]));
}

export async function discoverDshBaseUrl() {
  if (process.platform !== "darwin") {
    throw new Error("DSH_BASE_URL=auto is currently supported only on macOS");
  }
  const pids = await dshHostPids();
  for (const pid of pids) {
    for (const port of await listeningPorts(pid)) {
      const baseUrl = `http://127.0.0.1:${port}`;
      if (await probeDsh(baseUrl)) return baseUrl;
    }
  }
  throw new Error("DSH_HOST_NOT_FOUND: start DeepSeek Harness and retry");
}

async function resolveBaseUrl() {
  const configured = process.env.DSH_BASE_URL?.trim();
  if (configured && configured.toLowerCase() !== "auto") return assertLoopbackBase(configured);
  return discoverDshBaseUrl();
}

async function main(argv) {
  const baseUrl = await resolveBaseUrl();
  if (argv[0] === "--print-base") {
    process.stdout.write(`${new URL(baseUrl).origin}\n`);
    return;
  }
  const [serverPath] = argv;
  if (!serverPath) throw new Error("usage: launch-dsh-collab.mjs <codex-mcp-server.js> | --print-base");
  process.env.DSH_BASE_URL = baseUrl;
  const server = await import(pathToFileURL(resolve(serverPath)).href);
  if (typeof server.main !== "function") throw new Error(`MCP server does not export main(): ${serverPath}`);
  await server.main();
}

const launchedDirectly = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (launchedDirectly) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`[dsh-codex-collab-launcher] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
