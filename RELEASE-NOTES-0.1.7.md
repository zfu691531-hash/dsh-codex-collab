# 0.1.7

Preserves compatibility commits `24606c4` and `c2ba8ce`.

- Windows scans `%LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe` and orders usable builds by actual `codex-cli` SemVer, including numeric prerelease identifiers. No build hash is pinned. Explicit `codexCommand` and `CODEX_BIN` overrides take precedence; PATH and WindowsApps are fallbacks. Windows `.sandbox-bin` executables and aliases to them are rejected. Every candidate has an ordered diagnostic in the existing `failures` field.
- `codex_status.tasks[]` declares `codexCwd`. All three DSH tools apply lossless JSON cleanup and recursive projection using their own public `output.schema`, including task receipts, references, artifacts, and clarification results.
- Windows installation and doctor default to `DshBaseUrl=auto`; MCP smoke performs authenticated `session/list` through the companion's discovery logic before checking MCP tools. The configurator also defaults new registrations to auto. Existing Codex configuration is not changed by this release build.
- Windows installer selects the highest local TGZ when older packages remain alongside it. Documentation covers desktop profile hot reload, persistent `.npmrc` setting `virtual-store-dir-max-length=60`, and clearing the old hash override to enable automatic resolution.

## Build

```powershell
cd plugin
npm.cmd ci
npm.cmd run verify
npm.cmd test
npm.cmd pack
```

In a restricted filesystem where esbuild fails while traversing parent directories:

```powershell
npm.cmd run typecheck
npm.cmd run build:portable
npm.cmd test
npm.cmd pack
```

The portable build emits unbundled ESM and CJS modules, declarations for both formats, and source maps while preserving the package exports and executable entry point. Generated `dist/` remains ignored by Git and is included in the TGZ. Repository source and scripts are supplied in the separate source ZIP.

## Desktop retest

1. Finish active plugin tasks before upgrading: hot reload releases the old app-server and clears in-memory task mappings.
2. Ensure the desktop profile `.npmrc` matches `virtual-store-dir-max-length=60`; install the new TGZ using the desktop profile. No Harness restart is needed.
3. Clear an old hash-pinned `codexCommand` to `''` in the desktop patch and wait for hot reload.
4. Call `codex_status`: verify the selected desktop path/version and ordered `failures` diagnostics.
5. Start a fresh task with a real cwd, then call status again: `tasks[].codexCwd` must appear without an undeclared-property error. Reply to that task and verify the same threadId and valid structured receipts.
6. Run `doctor.ps1 -ProfileName desktop` with the default auto base URL; verify `DSH_HTTP_OK`, `MCP_COMPANION_OK`, and `DOCTOR_OK`.
7. After a Codex application update, reload the plugin and verify it selects the highest probed build without updating a hash path.
