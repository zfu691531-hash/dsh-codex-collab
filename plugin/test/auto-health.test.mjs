import assert from "node:assert/strict";
import { test } from "node:test";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadSource } from "./load-source.mjs";

test("auto health discovers a dynamic port and authenticates slash session/list without writing global config", async () => {
  const previousHome = process.env.DSH_HOME;
  const originalExecFile = childProcess.execFile;
  const home = await mkdtemp(fileURLToPath(new URL("./health-fixture-", import.meta.url)));
  assert.equal(path.dirname(path.resolve(home)), path.resolve(fileURLToPath(new URL(".", import.meta.url))));
  const secret = Buffer.alloc(32, 17).toString("base64url");
  await writeFile(`${home}/.credentials.yaml`, `client-connection/browser-session:\n  secret: ${secret}\n`);
  const requests = [];
  const commands = [];
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text);
    requests.push({ url: request.url, cookie: request.headers.cookie, body });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ type: "server-response", rpcId: body.rpcId, result: { ok: true, value: { sessions: [] } } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const mockExecFile = () => { throw new Error("Unexpected callback-style invocation"); };
  mockExecFile[promisify.custom] = async (command) => {
    commands.push(command);
    if (command === "tasklist") return { stdout: '"DeepSeek Harness.exe","1234"\n', stderr: "" };
    if (command === "netstat") return { stdout: Buffer.from(`  TCP    127.0.0.1:${port}    0.0.0.0:0    LISTENING    1234\n`), stderr: "" };
    throw new Error(`Unexpected command: ${command}`);
  };
  try {
    process.env.DSH_HOME = home;
    childProcess.execFile = mockExecFile;
    syncBuiltinESMExports();
    const { checkDshHealth } = await loadSource("../src/codex-mcp-server.ts");
    await checkDshHealth("auto");
    assert.deepEqual(commands, ["tasklist", "netstat"]);
    assert.equal(requests.length, 2); // discovery probe, then authenticated health
    for (const request of requests) {
      assert.equal(request.url, "/api/session/list");
      assert.equal(request.body.method, "session/list");
      assert.deepEqual(request.body.payload, { args: { _request: {} } });
      assert.match(request.cookie, /^dsh-auth-[\w-]+=v1\./u);
    }
    await checkDshHealth(`http://127.0.0.1:${port}`);
    assert.equal(requests.length, 3);
    assert.equal(commands.length, 2);
  } finally {
    childProcess.execFile = originalExecFile;
    syncBuiltinESMExports();
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    await new Promise((resolve) => server.close(resolve));
    // Only remove this test's generated directory within plugin/test.
    await rm(home, { recursive: true, force: true });
  }
});
