# Codex app-server contract

DSH → Codex uses the official Codex app-server JSONL protocol over stdio.
This is deliberately different from `codex mcp-server`: app-server creates an
interactive Codex thread that appears in Codex Desktop's normal task list.

Official protocol reference:
https://developers.openai.com/codex/app-server/

## Lifecycle

1. Spawn `codex app-server --listen stdio://`.
2. Send `initialize`, then the `initialized` notification.
3. Start a visible thread with `thread/start` and preserve its returned ID.
4. Run a turn with `turn/start` using a text input item.
5. Collect `item/completed` agent messages until matching `turn/completed`.
6. Before a follow-up, call `thread/resume`, then start another turn.

The plugin passes the current DSH workspace as `cwd` when DSH supplies one.
`defaultCwd` is only a fallback for calls without a workspace. The default
approval policy is `never` and the default sandbox is `workspace-write` because
interactive approval requests are not bridged in this release.

## Verified macOS regression

Verified with Codex CLI `0.148.0-alpha.9` from ChatGPT.app:

- `thread/start` and a follow-up on the same thread both completed.
- The thread was returned by an unfiltered `thread/list` call.
- Its source was `vscode`, cwd matched the requested repository, and Git info
  matched that repository.
- A full DSH → Codex round trip returned `DSH_TO_CODEX_OK CODEX_WORKER_OK`.
