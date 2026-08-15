import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const START = "# >>> dsh-codex-collab managed MCP >>>";
const END = "# <<< dsh-codex-collab managed MCP <<<";

function basicString(value) {
  return JSON.stringify(value);
}

function managedBlock({ nodePath, serverPath, cwd, baseUrl, launcherPath }) {
  const args = launcherPath ? [launcherPath, serverPath] : [serverPath];
  return [
    START,
    "[mcp_servers.dsh-collab]",
    `command = ${basicString(nodePath)}`,
    `args = [${args.map(basicString).join(", ")}]`,
    `cwd = ${basicString(cwd)}`,
    "startup_timeout_sec = 30",
    "tool_timeout_sec = 600",
    "",
    "[mcp_servers.dsh-collab.env]",
    `DSH_BASE_URL = ${basicString(baseUrl)}`,
    END,
  ].join("\n");
}

function removeManagedBlock(content) {
  const start = content.indexOf(START);
  if (start < 0) return { content, found: false };
  const end = content.indexOf(END, start);
  if (end < 0) throw new Error("CODEX_CONFIG_MANAGED_BLOCK_CORRUPTED: missing managed block end marker");
  const after = end + END.length;
  const beforeText = content.slice(0, start).replace(/[ \t]+$/u, "");
  const afterText = content.slice(after).replace(/^[\r\n]+/u, "");
  const joined = beforeText && afterText ? `${beforeText}\n\n${afterText}` : `${beforeText}${afterText}`;
  return { content: joined, found: true };
}

function hasUnmanagedDshServer(content) {
  return /^\s*\[mcp_servers\.dsh-collab\]\s*$/mu.test(content);
}

async function readConfig(path) {
  try {
    const bytes = await readFile(path);
    const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    return { content: bytes.toString("utf8").replace(/^\uFEFF/u, ""), hasBom, exists: true };
  } catch (error) {
    if (error?.code === "ENOENT") return { content: "", hasBom: false, exists: false };
    throw error;
  }
}

async function writeConfig(path, content, hasBom) {
  await mkdir(dirname(path), { recursive: true });
  const encoded = Buffer.from(`${hasBom ? "\uFEFF" : ""}${content}`, "utf8");
  await writeFile(path, encoded);
}

async function checkAdd(configPath) {
  const current = await readConfig(configPath);
  const withoutManaged = removeManagedBlock(current.content).content;
  if (hasUnmanagedDshServer(withoutManaged)) {
    throw new Error("CODEX_MCP_CONFLICT: an unmanaged [mcp_servers.dsh-collab] section already exists");
  }
}

async function add(configPath, options) {
  const current = await readConfig(configPath);
  const withoutManaged = removeManagedBlock(current.content).content;
  if (hasUnmanagedDshServer(withoutManaged)) {
    throw new Error("CODEX_MCP_CONFLICT: an unmanaged [mcp_servers.dsh-collab] section already exists");
  }
  const prefix = withoutManaged.trimEnd();
  const next = `${prefix ? `${prefix}\n\n` : ""}${managedBlock(options)}\n`;
  if (next === current.content) return "CODEX_MCP_ALREADY_CONFIGURED";
  if (current.exists) await copyFile(configPath, `${configPath}.dsh-codex-collab.bak`);
  await writeConfig(configPath, next, current.hasBom);
  return "CODEX_MCP_CONFIGURED";
}

async function remove(configPath) {
  const current = await readConfig(configPath);
  if (!current.exists) return "CODEX_CONFIG_NOT_FOUND";
  const removed = removeManagedBlock(current.content);
  if (!removed.found) return "CODEX_MCP_NOT_MANAGED";
  await copyFile(configPath, `${configPath}.dsh-codex-collab.bak`);
  const next = removed.content.trimEnd();
  await writeConfig(configPath, next ? `${next}\n` : "", current.hasBom);
  return "CODEX_MCP_REMOVED";
}

async function main(argv) {
  const [operation, configPath, nodePath, serverPath, cwd, baseUrl = "http://127.0.0.1:3080", launcherPath] = argv;
  if (!operation || !configPath) {
    throw new Error("usage: configure-codex.mjs <check-add|add|remove> <config> [node] [server] [cwd] [baseUrl]");
  }
  if (operation === "remove") return remove(configPath);
  if (operation !== "add" && operation !== "check-add") throw new Error(`unknown operation: ${operation}`);
  if (!nodePath || !serverPath || !cwd) throw new Error(`${operation} requires nodePath, serverPath, and cwd`);
  const options = { nodePath, serverPath, cwd, baseUrl, launcherPath };
  if (operation === "check-add") {
    await checkAdd(configPath);
    return "CODEX_MCP_CONFIG_OK";
  }
  return add(configPath, options);
}

try {
  process.stdout.write(`${await main(process.argv.slice(2))}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
