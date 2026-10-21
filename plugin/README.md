# dsh-codex-collab

DeepSeek Harness 原生插件 + 本机 MCP companion，让 DSH 与 Codex 双向分工。DSH → Codex 使用官方 app-server，创建的任务会出现在 Codex Desktop 正常任务列表中。

所有提示词通过原生 MCP/JSON UTF-8 链路传输，不依赖终端代码页。检测到
`U+FFFD`、非法 Unicode、C1 控制符或连续 `????` 等高置信度编码损坏时，
桥接返回可恢复的 `needs-clarification`，要求发送方澄清后重试；不会执行乱码，
也不会结束协作。URL、本机文件和 PDF 以结构化 `references` / `artifacts`
传递；正文中的 HTTP(S) URL 会自动提升为 reference，缺少单项时保留正文与
其他输入。完整契约见
[`docs/text-integrity.md`](docs/text-integrity.md) 和
[`docs/collaboration-message.md`](docs/collaboration-message.md)。

## 已实现

### DSH → Codex

- `codex_status`：检查 Codex、app-server、解析路径和任务映射。
- `codex_task_start`：创建 Codex thread。
- `codex_task_reply`：续接同一 Codex thread。
- Codex 不可用时 fail-soft；DSH 仍可启动并返回完整诊断。
- Cordis `ctx.effect` 管理 Codex app-server 子进程生命周期。

### Codex → DSH

- `dsh_task_start`：创建 DSH session 并派发任务。
- `dsh_task_reply`：续接同一 DSH session。
- `dsh_task_status`：读取 running/结束状态和最新正文。
- `dsh_task_cancel`：取消当前 DSH turn。
- `agent_preset: "cordis"` 显式启用 DSH 官方创造模式。
- companion 只允许访问 `localhost` / `127.0.0.1` / `::1`，不建设公网服务。

反向链路直接复用 DSH Web UI 自己使用的官方 Host API（`session.create/prompt/history/list/cancel`），不依赖 ACN，也不自造私有 named pipe。

## 架构

```text
DSH agent ── DSH tool ── stdio codex app-server ── visible Codex Desktop thread
Codex agent ── MCP tool ── stdio companion ── loopback DSH Host API ── DSH session
```

V1 的 Task 标识是 DSH `sessionId` / Codex `threadId`，语义保持简单，后续可映射 A2A，但当前不以 A2A 作为本机传输。

## 开发验证

```powershell
npm install
npm run typecheck
npm run build
npm test
```

仓库根目录提供真实双向联调：

```bash
node integration-smoke.mjs direct
node integration-smoke.mjs roundtrip
```

## DSH 安装

项目遵循 DSH rc.6 bundle 规范：`package.json.dsh.bundle.patch` 指向包内 `cordis.patch.yml`。

```powershell
npm pack
dsh plugin --profile desktop add D:\path\to\dsh-codex-collab-0.1.7.tgz
```

发布到 registry 后可直接：

```powershell
dsh plugin --profile web add dsh-codex-collab
```

## 让 Codex 看见 DSH 工具

先完成 `npm run build`，再注册同包 companion：

```powershell
codex mcp add dsh-collab --env DSH_BASE_URL=auto -- node D:\Projects\backend\dsh-codex-collab\dist\codex-mcp-server.js
codex mcp list
```

随后重启 Codex 客户端或新开任务。也可以把相同 command/args/env 写进可信项目的 `.codex/config.toml`，避免成为全局默认。当前工程没有替你修改 Codex 全局配置。

可选环境变量：

- `DSH_BASE_URL`：默认 `auto`，发现本次启动的 Host 动态端口；显式地址仅接受 HTTP loopback。
- `DSH_API_TIMEOUT_MS`：单次 Host API 超时，默认 15000。
- `DSH_TASK_TIMEOUT_MS`：等待一轮完成的上限，默认 600000。
- `DSH_POLL_INTERVAL_MS`：本机事件日志轮询间隔，默认 250。

## DSH 插件配置

```yaml
- id: dsh-codex-collab
  name: dsh-codex-collab
  config:
    codexCommand: ''
    defaultCwd: ''
    statusCommandTimeoutMs: 5000
    taskTimeoutMs: 300000
    connectTimeoutMs: 15000
    keepAlive: true
```

`codexCommand` 解析顺序：显式配置、`CODEX_BIN`、Windows 桌面 CLI、PATH、Windows App Execution Alias。桌面 CLI 扫描 `%LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe`，运行 `--version` 后按 SemVer 从高到低排序（含 alpha 数字序号），不依赖构建哈希。每次插件加载重新扫描；将旧的哈希路径配置清空为 `codexCommand: ''` 才会启用自动选择。Windows 禁止使用 `.sandbox-bin`，包括显式配置、PATH 和符号链接。选中后再检查 `app-server --help`；候选顺序、选择结果和失败原因均写入 `codex_status.failures`。

desktop profile 安装插件和修改 `cordis.patch.yml` 后由 Harness 热加载，无需重启。热加载会释放旧 app-server 和内存 taskId 映射，应等当前任务结束再升级。在该 profile 的 `.npmrc` 中持久设置 `virtual-store-dir-max-length=60`，避免 pnpm 后续安装时与已有虚拟存储配置冲突。详见仓库根目录 `README.windows.md`。

若 esbuild 因受限目录访问无法构建，可用 `npm run build:portable`：通过 TypeScript 生成同样的 ESM/CJS 入口、类型声明和 source maps，再运行 `npm test`、`npm pack`。`codex_status` 和任务工具的所有返回值均经过 lossless 清理和各自 `output.schema` 的递归投影。

## 当前边界

- DSH → Codex 的 task/thread 映射仍在内存中，DSH 重启后丢失；Codex → DSH 直接使用持久 sessionId，不受 companion 重启影响。
- 当前返回一轮最终结果和状态，不做 token 级流式转发。
- 尚未桥接 Codex/DSH 的交互式审批与提问。
- 不含多机、群聊、身份系统或公网 relay；这些属于后续远程协作层。
