# Patch notes — compatibility with DeepSeek Harness 0.2.x (typert gateway)

Applied 2026-10-21 on this machine (DSH 0.2.1-rc.2, Windows).

## Why the published 0.1.4 companion cannot talk to 0.2.x

Four independent breaks, all verified against the live Host:

| # | 0.1.4 assumption | 0.2.x reality |
|---|---|---|
| 1 | `POST /api/session.list` (dot method in the path) | only slash endpoints exist: `POST /api/session/list`; the dot name returns `404 not found` |
| 2 | body `method: "session.list"` | the gateway requires `method` to equal the endpoint name (`session/list`), otherwise `gateway/bad-request` |
| 3 | body `payload: {…}` | `payload.args` must hold exactly one descriptor-named field: `_request` for `session/list`, `request` for the other session endpoints |
| 4 | no auth header; fixed `http://127.0.0.1:3080` | every request needs the authority-bound browser-session cookie; the Host port is chosen at each launch |

Additionally `session.history` no longer exists; history is read through `session/page`, which needs a log cut (`throughSeq`) that the session summary exposes as `projections.asOfSeq`.

## What changed

- `plugin/src/dsh-api.ts`
  - mints the Host cookie: `dsh-auth-<b64url(sha256(authority))>` = `v1.<b64url(payload)>.<b64url(HMAC-SHA256(secret, body))>`,
    using the `client-connection/browser-session` secret from `$DSH_HOME/.credentials.yaml` (the record the Host writes itself).
  - discovers the Host origin on each connect: Windows `tasklist` + `netstat -ano`, then probes `/api/session/list` until one returns `ok: true`; macOS keeps `ps` + `lsof`. `DSH_BASE_URL=auto` now defaults to this path.
  - calls `/api/<slash-endpoint>` with `method` = endpoint and `payload.args.<parameter>`; retries once with the other parameter name if the descriptor disagrees.
  - implements `history()` over `session/page` (`throughSeq` from the session summary's `projections.asOfSeq`).
- `plugin/src/codex-mcp-server.ts`
  - default `DSH_BASE_URL` is now `auto` instead of the fixed `3080`.

## Verified on this machine

```text
dsh_task_status  → read an existing session's latest assistant message
dsh_task_start   → created session, prompted "只回复两个字：收到", waited, returned "收到" (state: succeeded)
```

## Deploy on Windows (what was done here)

```powershell
cd plugin
npm ci
npm run build
# stable copy
$pkg = "$env:USERPROFILE\.dsh\packages\dsh-codex-collab"
mkdir $pkg -Force
Copy-Item dist $pkg -Recurse -Force
Copy-Item package.json $pkg
cd $pkg; npm install --omit=dev --no-audit --no-fund
# register in Codex
node <repo>\configure-codex.mjs add "$env:USERPROFILE\.codex\config.toml" (Get-Command node).Source `
  "$pkg\dist\codex-mcp-server.js" $pkg auto
```

Restart the Codex app so it loads the MCP server; no DeepSeek Harness restart is needed for this direction.

## DSH → Codex (cordis plugin) on 0.2.x

Installed into the desktop profile (version bumped to 0.1.6). Three more fixes were needed:

1. **Peer range blocked installation.** 0.2.1's plugin manager refuses any plugin whose
   `@deepseek-ai/dsh-tools` requirement does not match, and the plugin declared `^0.1.0-rc.6`.
   Widened to `>=0.1.0-rc.6` (the API the plugin uses — `defineTool`, `ctx.tools.register`,
   `ctx.effect` — still exists in 0.2.1). Installing without this yields
   `Plugin dsh-codex-collab@0.1.4 is incompatible with dsh 0.2.1-rc.2`.
2. **Tool results were rejected as "not lossless JSON".** 0.2.x validates tool output strictly;
   `codex_status` returned optional fields as `undefined` (`version`, `resolved`, …).
   Added a `lossless()` pass in `plugin/src/tools.ts` that drops `undefined`/non-finite leaves
   before returning.
3. **The default Codex executable cannot run the configured model.** The resolver picked
   `~/.codex/.sandbox-bin/codex.exe` (codex-cli 0.153.1), which answers
   `The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account`.
   Pin the desktop CLI in the profile patch layer instead:

   ```yaml
   - id: dsh-codex-collab
     config:
       codexCommand: 'C:\Users\st\AppData\Local\OpenAI\Codex\bin\<hash>\codex.exe'  # codex-cli 0.163.0-alpha.10.2
       defaultCwd: ''
       statusCommandTimeoutMs: 5000
       taskTimeoutMs: 300000
       connectTimeoutMs: 15000
       keepAlive: true
   ```

   `<hash>` changes when the Codex app updates; re-point after an update.

Also note: the desktop profile has **no restart requirement** — the Harness hot-reloads plugin
installs and `cordis.patch.yml` edits (about 1–2 s). The plugin manager's version check runs at
install time, so a stale `cordis.patch.yml` override is applied without re-validation.

### Verified

```text
codex_status      → codexAvailable: true, version codex-cli 0.163.0-alpha.10.2, backend: app-server
codex_task_start  → "只回复两个字：收到" → 收到
codex_task_reply  → "再回复两个字：也收到" → 也收到
```

## Still open

- Deleting a Session is not exposed as a gateway endpoint; `session/delete` is ACP-only (`404` over HTTP).
- The `codexCommand` path is version-pinned because Codex keeps the CLI under a build hash directory.
