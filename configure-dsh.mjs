import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const START = "# >>> dsh-codex-collab managed config >>>";
const END = "# <<< dsh-codex-collab managed config <<<";

function yamlString(value) {
  return JSON.stringify(value);
}

function managedBlock(codexCommand) {
  return [
    START,
    "- id: dsh-codex-collab",
    "  config:",
    `    codexCommand: ${yamlString(codexCommand)}`,
    "    defaultCwd: \"\"",
    "    statusCommandTimeoutMs: 5000",
    "    taskTimeoutMs: 300000",
    "    connectTimeoutMs: 15000",
    "    keepAlive: true",
    END,
  ].join("\n");
}

function removeManagedBlock(content) {
  const start = content.indexOf(START);
  if (start < 0) return { content, found: false };
  const end = content.indexOf(END, start);
  if (end < 0) {
    throw new Error("DSH_CONFIG_MANAGED_BLOCK_CORRUPTED: missing managed block end marker");
  }
  const after = end + END.length;
  const beforeText = content.slice(0, start).replace(/[ \t\r\n]+$/u, "");
  const afterText = content.slice(after).replace(/^[\r\n]+/u, "");
  const joined = beforeText && afterText ? `${beforeText}\n${afterText}` : `${beforeText}${afterText}`;
  return { content: joined, found: true };
}

function normalizeBase(content) {
  const trimmed = content.trim();
  if (!trimmed || trimmed === "[]") return "";
  const lines = trimmed.split(/\r?\n/u);
  const meaningfulLines = lines
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  if (meaningfulLines.length === 1 && meaningfulLines[0] === "[]") {
    return lines.filter((line) => line.trim() !== "[]").join("\n").trimEnd();
  }
  const meaningful = meaningfulLines[0];
  if (meaningful && !meaningful.startsWith("-")) {
    throw new Error("DSH_PATCH_UNSUPPORTED: cordis.patch.yml must contain a top-level YAML list");
  }
  return content.trimEnd();
}

function hasUnmanagedEntry(content) {
  return /^\s*-?\s*id\s*:\s*['"]?dsh-codex-collab['"]?\s*$/mu.test(content);
}

async function readPatch(path) {
  try {
    return { content: await readFile(path, "utf8"), exists: true };
  } catch (error) {
    if (error?.code === "ENOENT") return { content: "", exists: false };
    throw error;
  }
}

async function writePatch(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

async function checkAdd(path) {
  const current = await readPatch(path);
  const withoutManaged = removeManagedBlock(current.content).content;
  if (hasUnmanagedEntry(withoutManaged)) {
    throw new Error("DSH_PLUGIN_CONFIG_CONFLICT: an unmanaged dsh-codex-collab entry already exists");
  }
  normalizeBase(withoutManaged);
}

async function add(path, codexCommand) {
  const current = await readPatch(path);
  const withoutManaged = removeManagedBlock(current.content).content;
  if (hasUnmanagedEntry(withoutManaged)) {
    throw new Error("DSH_PLUGIN_CONFIG_CONFLICT: an unmanaged dsh-codex-collab entry already exists");
  }
  const base = normalizeBase(withoutManaged);
  const next = `${base ? `${base}\n` : ""}${managedBlock(codexCommand)}\n`;
  if (next === current.content) return "DSH_PLUGIN_CONFIG_ALREADY_CONFIGURED";
  if (current.exists) await copyFile(path, `${path}.dsh-codex-collab.bak`);
  await writePatch(path, next);
  return "DSH_PLUGIN_CONFIG_CONFIGURED";
}

async function remove(path) {
  const current = await readPatch(path);
  if (!current.exists) return "DSH_PATCH_NOT_FOUND";
  const removed = removeManagedBlock(current.content);
  if (!removed.found) return "DSH_PLUGIN_CONFIG_NOT_MANAGED";
  await copyFile(path, `${path}.dsh-codex-collab.bak`);
  const base = normalizeBase(removed.content);
  const hasListContent = base
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .some((line) => line && !line.startsWith("#"));
  await writePatch(path, hasListContent ? `${base}\n` : `${base ? `${base}\n` : ""}[]\n`);
  return "DSH_PLUGIN_CONFIG_REMOVED";
}

async function main(argv) {
  const [operation, patchPath, codexCommand] = argv;
  if (!operation || !patchPath) {
    throw new Error("usage: configure-dsh.mjs <check-add|add|remove> <cordis.patch.yml> [codex-command]");
  }
  if (operation === "remove") return remove(patchPath);
  if (operation !== "add" && operation !== "check-add") throw new Error(`unknown operation: ${operation}`);
  if (!codexCommand) throw new Error(`${operation} requires an absolute Codex command path`);
  if (operation === "check-add") {
    await checkAdd(patchPath);
    return "DSH_PLUGIN_CONFIG_OK";
  }
  return add(patchPath, codexCommand);
}

try {
  process.stdout.write(`${await main(process.argv.slice(2))}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
