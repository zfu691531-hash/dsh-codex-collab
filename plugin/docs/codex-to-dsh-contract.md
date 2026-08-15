# Codex → DSH 本机协议

## Transport

- 上游：Codex MCP host 通过 stdio 启动 `dist/codex-mcp-server.js`。
- 下游：companion 请求 `http://127.0.0.1:3080/api/<method>`。
- DSH wire：`client-request` / `server-response` envelope，rpcId 必须回显一致。
- 安全边界：只允许 HTTP loopback 主机；不提供监听端口，不接受远端 URL。
- 文本边界：MCP stdio 使用 UTF-8；HTTP JSON 显式声明 `charset=utf-8`。可识别的正文损坏返回可恢复的 `needs-clarification`，不创建错误任务，也不终止协作。

## DSH Host API 映射

| MCP tool | DSH API |
|---|---|
| `dsh_task_start` | `session.create` → `session.history` → `session.prompt`；可选 `references` / `artifacts` |
| `dsh_task_reply` | `session.history` → `session.prompt`；可选 `references` / `artifacts` |
| `dsh_task_status` | `session.list` + `session.history` |
| `dsh_task_cancel` | `session.cancel` |

## Creator mode

DSH 官方创造模式的协议 ID 是 `cordis`。调用示例：

```json
{
  "name": "dsh_task_start",
  "arguments": {
    "prompt": "检查这个 DSH 插件",
    "cwd": "D:\\Projects\\backend\\dsh-codex-collab",
    "agent_preset": "cordis",
    "wait": true
  }
}
```

## Output

正常结果回显结构化 `message` 和 `inputIssues`，使下一跳 Agent 不必从正文重新猜测链接或文件：

```json
{
  "taskId": "session-...",
  "sessionId": "session-...",
  "state": "succeeded",
  "ok": true,
  "content": "...",
  "turnEndReason": "completed",
  "agentPreset": "cordis"
}
```

正文损坏返回 `state: "needs-clarification"`、`recoverable: true` 和
`action: "ask-sender-and-retry"`，它不是工具崩溃。新任务不创建 session；
reply 保留原 sessionId。单个资源不可用时任务仍携带其余输入执行，并通过
`inputIssues` 要求接收 Agent 向协作者补充缺失项。

`taskId` 与 `sessionId` 相同，因此 companion 重启后仍能直接续接，不需要本地映射数据库。
