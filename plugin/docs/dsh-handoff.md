# DSH-Codex Collab V1 交接说明

## 当前结论

V1 本机双向链路已跑通：

- DSH 通过 stdio `codex app-server` 创建和续接可在 Codex Desktop 中显示的 thread。
- Codex 通过同包 stdio MCP companion 调用 DSH 官方 loopback Host API，创建、续接、查询和取消 DSH session。
- 插件开发任务可显式指定 `agentPreset = cordis`，即 DSH 官方“创造模式”。

## 为什么反向不再使用 named pipe

DSH rc.6 已提供 Web UI 和其他客户端共用的 Host API：`session.create`、`session.prompt`、`session.history`、`session.list`、`session.cancel`。继续增加一套 named-pipe 私有协议会重复 DSH 已有的会话语义和校验。

因此反向路径固定为：

`Codex → stdio MCP companion → HTTP loopback DSH Host API → DSH agent/session`

companion 强制 URL 为 HTTP loopback，不接受公网或局域网地址。它不持有账号、token 或云端状态。

## 对外任务契约

| 工具 | 标识 | 行为 |
|---|---|---|
| `dsh_task_start` | 返回 DSH sessionId 作为 taskId | 创建 session、发送首条 prompt；可选 cwd/preset/wait |
| `dsh_task_reply` | taskId = sessionId | 在同一 session 排队下一条 prompt |
| `dsh_task_status` | taskId = sessionId | 从 session list + event log 推导状态和最新正文 |
| `dsh_task_cancel` | taskId = sessionId | 取消当前 active turn |

完成判定不依赖瞬时 `running`：发送前记录 baseline seq，等待新的 `turn/end`，再提取 baseline 后最后一条非空 `assistant/message`。结束状态映射：

- `completed` → `succeeded`
- `aborted` → `cancelled`
- `blocked` / `error` / `max-tokens` / 其他结束原因 → `failed`
- 无结束记录且 running → `running`
- 无结束记录且未运行 → `queued`

## 验证证据

- 新增反向单元用例 16 个：RPC envelope、loopback 限制、DSH 业务错误、creator preset、异步派发、同 session 续接、忙碌会话排队 turn 关联、状态映射、取消、MCP schema/参数校验。
- 真实反向联调：MCP client 启动 package companion，列出四个工具；以 `cordis` 创建 DSH 会话，得到 `DSH_REVERSE_BRIDGE_OK`；在同一 session 续接得到 `DSH_REVERSE_REPLY_OK`；status 返回同一 session 的 succeeded 和最新正文。
- 真实会话 cwd 为 `D:\Projects\backend\dsh-codex-collab`，preset 为 `cordis`，完成后 idle。
- 既有 DSH → Codex 真实 start/reply 同 thread 联调继续保留。

## 生命周期与故障边界

- DSH 插件侧的 Codex MCP 子进程仍由 `ctx.effect` 关闭。
- Codex 侧 companion 是 stdio 子进程，由 Codex MCP host 启停，没有额外 daemon。
- DSH 未启动或端口错误时，工具返回 `DSH_UNAVAILABLE`，不会让 Codex 或 DSH 启动失败。
- 非 loopback URL 在 companion 初始化阶段直接拒绝。

## 尚未实现

- token/step 级流式进度。
- 双方审批、提问和用户确认事件的转发。
- DSH → Codex task 映射持久化。
- 多机身份、加密、群聊、离线消息、远程 relay。
- A2A transport；当前只保持 Task/Message/Artifact 语义可映射。

这些边界不影响当前本机的双向任务分发、续接、状态和取消。
