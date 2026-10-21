import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { readFile } from "node:fs/promises";
import ts from "typescript";

// Transpile the actual source; probes are injected, never run a global CLI.
const source = await readFile(new URL("../src/resolver.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { defaultResolver } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputText).toString("base64")}`);
const p = path.win32;
const local = "C:\\Users\\Example User\\AppData\\Local";
const root = p.join(local, "OpenAI", "Codex", "bin");
const desktop = (build) => p.join(root, build, "codex.exe");
const sandbox = "C:\\Users\\Example User\\.codex\\.sandbox-bin\\codex.exe";

function fixture({ versions = {}, builds = [], env = {}, platform = "win32", listError, aliases = {} } = {}) {
  const invoked = [];
  const invoke = async (command) => {
    invoked.push(command);
    const value = versions[command];
    if (value instanceof Error) throw value;
    return typeof value === "string"
      ? { code: 0, stdout: `codex-cli ${value}\n`, stderr: "" }
      : { code: 1, stdout: "", stderr: "Access denied" };
  };
  const exists = async (file) => Object.hasOwn(versions, file);
  const runtime = {
    platform,
    listDirectories: async (directory) => {
      assert.equal(directory, root);
      if (listError) throw listError;
      return builds;
    },
    canonicalPath: async (file) => aliases[file] ?? file,
  };
  const resolve = (override = "") => defaultResolver(override, { LOCALAPPDATA: local, PATH: "", ...env }, invoke, exists,
    "C:\\Users\\Example User", runtime).resolve();
  return { resolve, invoked };
}

test("desktop versions outrank PATH and sandbox; numeric prerelease ordering ignores hash order", async () => {
  const old = desktop("zzz-old");
  const current = desktop("aaa-current");
  const f = fixture({ builds: ["zzz-old", "aaa-current"], versions: {
    [old]: "0.163.0-alpha.9.2", [current]: "0.163.0-alpha.10.2", [sandbox]: "0.153.1",
    "C:\\cli\\codex.EXE": "0.150.0",
  }, env: { PATH: `C:\\cli;${p.dirname(sandbox)}` } });
  const result = await f.resolve();
  assert.equal(result.executable, current);
  assert.deepEqual(result.candidates.filter((c) => c.source === "desktop").map((c) => c.path), [current, old]);
  assert.ok(!f.invoked.includes(sandbox));
});

test("release beats prerelease and newer core beats release", async () => {
  const f = fixture({ builds: ["alpha", "release", "next"], versions: {
    [desktop("alpha")]: "0.163.0-alpha.99", [desktop("release")]: "0.163.0", [desktop("next")]: "0.164.0-alpha.1",
  } });
  const result = await f.resolve();
  assert.deepEqual(result.candidates.filter((c) => c.source === "desktop").map((c) => c.path),
    [desktop("next"), desktop("release"), desktop("alpha")]);
});

test("explicit overrides win and failed override falls through with diagnostics", async () => {
  const f = fixture({ builds: ["current"], versions: { "C:\\custom.exe": "0.160.0", "C:\\env.exe": "0.161.0", [desktop("current")]: "0.163.0" },
    env: { CODEX_BIN: "C:\\env.exe" } });
  assert.equal((await f.resolve("C:\\custom.exe")).executable, "C:\\custom.exe");
  const result = await f.resolve("C:\\missing.exe");
  assert.equal(result.executable, "C:\\env.exe");
  assert.match(result.failures.find((f) => f.path === "C:\\missing.exe").reason, /not found/);
});

test("failed and malformed desktop probes are reported, and the next valid build wins", async () => {
  const f = fixture({ builds: ["broken", "invalid", "ok", "missing"], versions: {
    [desktop("broken")]: new Error("cannot launch"), [desktop("invalid")]: "unknown", [desktop("ok")]: "0.163.0",
  } });
  const result = await f.resolve();
  assert.equal(result.executable, desktop("ok"));
  for (const build of ["broken", "invalid", "missing"]) assert.ok(result.failures.some((f) => f.path === desktop(build)));
});

test("sandbox is rejected through overrides, PATH, and symlinks; no silent home fallback", async () => {
  const alias = "C:\\cli\\codex.EXE";
  const f = fixture({ versions: { [sandbox]: "0.153.1", [alias]: "0.153.1" },
    env: { PATH: `${p.dirname(sandbox)};C:\\cli`, CODEX_BIN: sandbox }, aliases: { [alias]: sandbox } });
  const result = await f.resolve(sandbox);
  assert.equal(result.executable, "");
  assert.deepEqual(f.invoked, []);
  assert.ok(result.failures.some((f) => /sandbox.*excluded/i.test(f.reason)));
});

test("desktop discovery failures and launch failures remain visible when falling back to an absolute PATH entry", async () => {
  const exe = "C:\\cli\\codex.EXE";
  const f = fixture({ listError: new Error("permission denied"), versions: { [exe]: "0.163.0" }, env: { Path: "C:\\cli" } });
  const result = await f.resolve();
  assert.equal(result.executable, exe);
  assert.ok(result.failures.some((f) => /permission denied/.test(f.reason)));
});

test("non-Windows PATH keeps extensionless executable support", async () => {
  const f = fixture({ platform: "linux", env: { PATH: "/usr/local/bin:/usr/bin" }, versions: { "/usr/bin/codex": "0.163.0" } });
  assert.equal((await f.resolve()).executable, "/usr/bin/codex");
});

test("failures includes the entire candidate selection order with reasons", async () => {
  const f = fixture({ builds: ["old", "new"], versions: {
    [desktop("old")]: "0.153.1", [desktop("new")]: "0.163.0",
  } });
  const result = await f.resolve("C:\\missing.exe");
  for (const [index, candidate] of result.candidates.entries()) {
    const diagnostic = result.failures.find((failure) => failure.path === candidate.path);
    assert.match(diagnostic?.reason ?? "", new RegExp(`candidate #${index + 1} `));
  }
  assert.match(result.failures.find((failure) => failure.path === result.executable).reason, /selected/);
});

test("re-resolving discovers new desktop builds without changing config or hashes", async () => {
  const builds = ["original"];
  const versions = { [desktop("original")]: "0.163.0" };
  const f = fixture({ builds, versions });
  assert.equal((await f.resolve()).executable, desktop("original"));
  builds.push("updated");
  versions[desktop("updated")] = "0.164.0-alpha.1";
  assert.equal((await f.resolve()).executable, desktop("updated"));
});
