// Checks built ESM/CJS companions against a controlled authenticated Host on a
// random loopback port. No Harness session, global config, or process is changed.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testRoot = fileURLToPath(new URL(".", import.meta.url));
const home = await mkdtemp(path.join(testRoot, "release-fixture-"));
assert.equal(path.dirname(path.resolve(home)), path.resolve(testRoot));
const secret = Buffer.alloc(32, 23).toString("base64url");
await writeFile(path.join(home, ".credentials.yaml"), `client-connection/browser-session:\n  secret: ${secret}\n`);
const server = createServer(async (request, response) => {
  let text = "";
  for await (const chunk of request) text += chunk;
  const body = JSON.parse(text);
  assert.equal(request.url, "/api/session/list");
  assert.equal(body.method, "session/list");
  assert.deepEqual(body.payload, { args: { _request: {} } });
  assert.match(request.headers.cookie, /^dsh-auth-[\w-]+=v1\./u);
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ type: "server-response", rpcId: body.rpcId, result: { ok: true, value: { sessions: [] } } }));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  for (const extension of ["js", "cjs"]) {
    const { stdout } = await promisify(execFile)(process.execPath, [
      fileURLToPath(new URL("../../mcp-smoke.mjs", import.meta.url)), process.execPath,
      fileURLToPath(new URL(`../dist/codex-mcp-server.${extension}`, import.meta.url)),
      fileURLToPath(new URL("..", import.meta.url)), baseUrl,
    ], { env: { ...process.env, DSH_HOME: home }, windowsHide: true, timeout: 30_000 });
    assert.match(stdout, /DSH_HTTP_OK http:\/\/127\.0\.0\.1:\d+ session\/list/u);
    assert.match(stdout, /MCP_SERVER_VERSION 0\.1\.7/u);
    assert.match(stdout, /MCP_COMPANION_OK dsh_task_cancel,dsh_task_reply,dsh_task_start,dsh_task_status/u);
    process.stdout.write(`${extension.toUpperCase()} ${stdout}`);
  }
  console.log("RELEASE_SMOKE_OK ESM + CJS; dynamic loopback port; authenticated health + MCP handshake");
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(home, { recursive: true, force: true });
}
