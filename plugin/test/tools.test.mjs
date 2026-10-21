import assert from "node:assert/strict";
import { test } from "node:test";
import { loadSource } from "./load-source.mjs";

const { createTools } = await loadSource("../src/tools.ts");
const { Codes, CodexCollabError } = await loadSource("../src/errors.ts");
const task = { taskId: "task", threadId: "thread", state: "awaiting-reply", codexCwd: "C:\\work", lastContent: "你好", futureField: "internal" };
const message = { text: "你好", references: [{ uri: "https://example.com", futureField: true }], artifacts: [{ path: "C:\\file.pdf", mediaType: "application/pdf", status: "available", sizeBytes: NaN, name: undefined, futureField: true }], futureField: true };
const manager = {
  getBackendKind: () => "fake", listTasks: async () => [task],
  probe: async () => ({ codexAvailable: true, mcpServerHelpOk: true, failures: [], backend: "fake", tasks: [task] }),
  start: async () => ({ taskId: "task", threadId: "thread", content: "你好", ok: true, message, inputIssues: [], futureField: true }),
  reply: async () => ({ threadId: "thread", content: "继续", ok: true, message, inputIssues: [], futureField: true }),
};

function assertDeclared(value, schema) {
  if (Array.isArray(value)) return value.forEach((item) => assertDeclared(item, schema.items));
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    assert.ok(Object.hasOwn(schema.properties, key), `${key} is not a declared property`);
    assert.notEqual(item, undefined);
    assertDeclared(item, schema.properties[key]);
  }
}

for (const withProbe of [false, true]) test(`status preserves codexCwd and projects future fields (cached probe=${withProbe})`, async () => {
  const tools = createTools(manager, withProbe ? () => ({ codexAvailable: true, mcpServerHelpOk: true, failures: [], version: undefined, resolved: "" }) : undefined);
  const result = await tools.status.execute({}, {});
  assert.equal(tools.status.output.schema.properties.tasks.items.properties.codexCwd?.type, "string");
  assert.equal(result.tasks[0].codexCwd, "C:\\work");
  assertDeclared(result, tools.status.output.schema);
  assert.deepEqual(result, JSON.parse(JSON.stringify(result)));
});

for (const name of ["taskStart", "taskReply"]) test(`${name} projects nested collaboration outputs and retains receipts`, async () => {
  const tool = createTools(manager)[name];
  const result = await tool.execute({ taskId: "task", prompt: "你好" }, {});
  assert.equal(result.state, "succeeded");
  assert.equal(result.message.text, "你好");
  assert.equal(result.message.references[0].uri, "https://example.com");
  assert.equal(result.message.artifacts[0].path, "C:\\file.pdf");
  assertDeclared(result, tool.output.schema);
  assert.deepEqual(result, JSON.parse(JSON.stringify(result)));
});

for (const name of ["taskStart", "taskReply"]) test(`${name} preserves clarification results through both output guards`, async () => {
  const fail = async () => { throw new CodexCollabError(Codes.PROMPT_ENCODING_CORRUPTED, "damaged input"); };
  const tool = createTools({ ...manager, start: fail, reply: fail })[name];
  const result = await tool.execute({ taskId: "task", prompt: "你好" }, {});
  assert.equal(result.state, "needs-clarification");
  assert.equal(result.recoverable, true);
  assert.equal(result.code, "PROMPT_ENCODING_CORRUPTED");
  assertDeclared(result, tool.output.schema);
});
