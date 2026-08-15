# Legacy Codex MCP Contract (compatibility reference)

`0.1.4` 起，DSH → Codex 的默认后端已改为官方 app-server，以便任务出现在 Codex Desktop 默认列表中。本文件仅保留旧 MCP adapter 的兼容性契约；当前协议见 `codex-app-server-contract.md`。

Verified on 2026-08-15 against:

- Codex CLI: `0.144.0-alpha.4`
- MCP SDK: `@modelcontextprotocol/sdk@1.30.0`
- Transport: stdio

## Executable discovery

On the current Windows installation, `Get-Command codex` resolves to the Microsoft Store package under `C:\Program Files\WindowsApps`, but launching that resolved path from Windows PowerShell 5.1 returns `Access denied`.

The Codex App provides an executable copy at:

```text
C:\Users\<user>\.codex\.sandbox-bin\codex.exe
```

The plugin must not hard-code the current username or this path as a universal default. It should support:

1. explicit `codexCommand` configuration;
2. a platform-specific, injectable executable resolver;
3. an ordered diagnostics result listing attempted candidates and launch errors.

## Tool: `codex`

Starts a new Codex thread.

Input:

```ts
interface CodexStartInput {
  prompt: string
  cwd?: string
  'approval-policy'?: 'untrusted' | 'on-request' | 'never'
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'
  model?: string
  config?: Record<string, unknown>
  'base-instructions'?: string
  'compact-prompt'?: string
  'developer-instructions'?: string
}
```

Output:

```ts
interface CodexToolOutput {
  threadId: string
  content: string
}
```

## Tool: `codex-reply`

Continues an existing Codex thread.

Input:

```ts
interface CodexReplyInput {
  prompt: string
  threadId: string
  conversationId?: string // deprecated compatibility alias
}
```

The published input schema only marks `prompt` as required for backward compatibility, but the bridge must require either `threadId` or deprecated `conversationId` before invoking the tool.

Output is `CodexToolOutput`.

## Verified smoke

The following read-only sequence succeeded:

1. `codex` with `sandbox=read-only`, `approval-policy=never`, and the project directory as `cwd` returned `DSH_CODEX_MCP_OK` plus thread ID `01a00428-90ac-7772-b398-bb6c9bbab23d`.
2. `codex-reply` with the same thread ID returned `DSH_CODEX_REPLY_OK` and preserved the thread ID.

No project file was modified by the smoke test.

## DSH tool mapping

| DSH tool | Codex MCP operation |
|---|---|
| `codex_status` | executable resolution + MCP initialize + `tools/list` validation |
| `codex_task_start` | call `codex`, persist returned `threadId` |
| `codex_task_reply` | resolve DSH task to `threadId`, call `codex-reply` |

Do not implement or reference `task/start` or `task/reply`; those are not present in the verified local Codex MCP server.
