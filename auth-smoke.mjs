import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [serverPath, baseUrl = "http://127.0.0.1:3080"] = process.argv.slice(2);
try {
  if (!serverPath) throw new Error("usage: auth-smoke.mjs <codex-mcp-server.js> [baseUrl]");
  const { checkDshConnection } = await import(pathToFileURL(resolve(serverPath)).href);
  await checkDshConnection(baseUrl);
  process.stdout.write("DSH_AUTH_API_OK session.list\n");
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "DSH authentication check failed"}\n`);
  process.exitCode = 1;
}
