# HARNESS_RC5_CONTRACT — dsh-realtime-voice 与 DeepSeek Harness rc.5 的接口契约

> 用途：给 dsh-realtime-voice 的实现者（Codex）一份"可直接编码"的精确契约。
> 所有结论来自本机 rc.5 实装源码/类型声明（`/Applications/DeepSeek Harness.app/Contents/Resources/host/node_modules/@deepseek-ai/…`）与桌面壳（`app.asar/lib/main.js`）。
> 约定：**标注「待 PoC」的项表示类型面已见到、但运行期行为未在本机验证，实现时必须先用最小实验确认，不得按猜测编码。**
> 版本基线：本机所有核心包 = `0.1.0-rc.5`（dsh-agent / dsh-session / dsh-tools / dsh-shell / dsh-commands / dsh-jobs 均为 rc.5）。

---

## 1. Host / Client 服务：inject 名、方法签名、真实包路径

### 1.1 Host 平面（SDP 代理、helper 常驻于此处；Host 是桌面壳 spawn 的纯 Node 子进程，`ELECTRON_RUN_AS_NODE=1`，env `DSH_DESKTOP=1`，见 `app.asar/lib/main.js` L194-217 / L466）

| inject / ctx 键 | 方法签名 | 包（lib/types 下的 .d.ts） | 挂载行（实时清单） |
|---|---|---|---|
| `webServer` | `register(route: WebRoute): () => void`；`registerUpgrade(route: WebUpgradeRoute): () => void`；`registerFallback(h): () => void`；`tapIndex(t): () => void` | `@deepseek-ai/dsh-host-webserver` → `lib/types/index.d.ts` | `include:webserver`（active） |
| `credentials` | `resolve(ref: CredentialRef): Promise<ResolvedCredential \| undefined>`；`credentialRef(value: string): CredentialRef` | `@deepseek-ai/dsh-credentials` → `lib/types/index.d.ts` | `include:credentials`（active） |
| `subprocess` | `spawn(spec: SubprocessSpawnSpec): SubprocessHandle`；`resolveExecutable(cmd, env?, signal?): Promise<string>` | `@deepseek-ai/dsh-subprocess` → `lib/types/index.d.ts` + `types.d.ts` | `include:subprocess`（`@deepseek-ai/dsh-subprocess-local`，active） |
| `shell` | `resolve(req): ShellExecSpec`；`run(spec): Promise<ShellRunResult>`；`start(spec): ShellProcess` | `@deepseek-ai/dsh-shell` → `lib/types/index.d.ts` + `types.d.ts` | 由 `include:bash-sandbox`（`@deepseek-ai/dsh-bash-sandbox` → `SandboxBashExecutor`）提供，active |

- `WebRoute = { kind: 'exact' | 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }`；`WebUpgradeRoute = { path: string; handler: (req, socket: Duplex, head: Buffer) => void | Promise<void> }`（webserver index.d.ts L19-35）。
- `SubprocessSpawnSpec = { argv: readonly string[]; cwd: string; stdio: SubprocessStdio; graceMs: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv }`（dsh-subprocess types.d.ts L67-92）。**argv 绝不经 shell 解释**——spawn 自家 helper 用 `ctx.subprocess`（绕开 bash-sandbox 的沙箱拦截面），不要用 `ctx.shell` 跑二进制（shell 命令走 sandbox，绝对路径 helper 的执行与写权限受 workspace 策略约束，行为待 PoC）。
- 路由/监听卸载统一用 Cordis effect：`ctx.effect(() => { const d = ctx.webServer.register(route); return d; })`——插件卸载时 disposer 自动执行（loader 与各官方 UI 插件同款模式）。

### 1.2 Client 平面（浏览器半，`window.__ModuleLoader__.load({ id, factory })` 内）

| inject / ctx 键 | 关键签名 | 包 | 说明 |
|---|---|---|---|
| `connection` | `ConnectionHandle { api: IApiClient; isLoopback: boolean; hostDescription: HostDescriptionSource; rpc: ClientConnectionRpc; start(sinks, config?) }` | `@deepseek-ai/dsh-client-connection` → `lib/types/client/index.d.ts` | **唯一能拿到 envelope rpcId 的面**（见 §4） |
| `remote` | `TypertClientRemote`（`ctx.remote.session.prompt(...)` 返回 `RpcResult<T>`，**rpcId 被剥掉**） | `@deepseek-ai/dsh-api-gateway` → `lib/types/client/index.d.ts`；实现见 `dsh-api-gateway/lib/types/client/index.js` `invoke()` | 高层便捷面，**不可用于 rpcId 捕获** |
| `slots` | `SlotRegistry.register(options)`（见 §10） | `@deepseek-ai/dsh-client-ui-slots` → `lib/types/index.d.ts` | 麦克风按钮/状态坞注册 |
| `locale` | `ctx.locale.register(NS, dict)` / `ctx.locale.bind(NS)` | `@deepseek-ai/dsh-client-locale` | 可选 |
| `sessions`（client-runtime 提供） | `Session` facade：`prompt(content, mode): Promise<RpcResult<{accepted:true}>>`（**同样剥 rpcId**） | `@deepseek-ai/dsh-client-runtime` → `lib/types/client/sessions/session.d.ts` L137 | 官方 UI 用它，rpcId 关联不可用它 |

关键类型（`@deepseek-ai/dsh-host-apiproxy/lib/types/api/rpc.d.ts`）：
```ts
export interface RpcResponse<T> { rpcId: RpcId; result: RpcResult<T> }   // L222-225
export type RpcResult<T> = { ok: true; value: T } | { ok: false; error: RpcError }
```
`IApiClient`（`dsh-host-apiproxy/lib/types/fetch/client.d.ts`）文件头注释原文：
> "Business code needing the call's rpcId reads it from the RpcResponse echo."

---

## 2. 包格式（最小可装载）

### 2.1 package.json（照抄 `dsh-voice-webspeech` / `dsh-mic-input` 已验证结构）

```jsonc
{
  "name": "dsh-realtime-voice",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" },
    "./package.json": "./package.json"
  },
  "files": ["lib/**/*.js", "lib/**/*.d.ts", "cordis.patch.yml", "README.md", "LICENSE"],
  "dsh": {
    "client": { "platform": "web", "inject": [
      "@deepseek-ai/dsh-client-locale",
      "@deepseek-ai/dsh-client-runtime",
      "@deepseek-ai/dsh-client-ui-conversation",
      "@deepseek-ai/dsh-client-ui-settings",
      "@deepseek-ai/dsh-client-ui-settings-plugins",
      "@deepseek-ai/dsh-client-ui-slots",
      "@deepseek-ai/dsh-api-remotes"
    ] },
    "bundle": { "patch": "./cordis.patch.yml" }
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": ">=4.0.1-rc.1 <4.1.0",
    "@deepseek-ai/dsh-client-locale": ">=0.1.0-rc.3 <0.2.0",
    "@deepseek-ai/dsh-client-runtime": ">=0.1.0-rc.3 <0.2.0",
    "@deepseek-ai/dsh-client-ui-conversation": ">=0.1.0-rc.3 <0.2.0",
    "@deepseek-ai/dsh-client-ui-slots": ">=0.1.0-rc.3 <0.2.0",
    "@deepseek-ai/dsh-api-remotes": ">=0.1.0-rc.3 <0.2.0",
    "react": "^18.2.0", "react-dom": "^18.2.0"
  }
}
```
- peer 用 `>=0.1.0-rc.3 <0.2.0` 区间 = 同一 tarball 兼容 rc.5 与 rc.6；**只用 rc.5 已存在的 API**。
- `dsh.client.inject` 的字符串必须能在包内 `exports.inject`（浏览器半）里一一对应。

### 2.2 cordis.patch.yml（bundle patch，一行挂载）

```yaml
# dsh-realtime-voice bundle patch —— 挂载进 profile 插件树（host 半为空也成立，仅让客户端 bundle 被发现）。
- insert:
    - id: dsh-realtime-voice
      name: dsh-realtime-voice
      config: {}
```

### 2.3 浏览器半格式（`lib/client.js`，照抄 `dsh-client-ui-model-selection/lib/client.js` 的壳）

```js
window.__ModuleLoader__.load({
  id: "dsh-realtime-voice",
  factory: (require) => {
    // … 实现，最后：
    exports.apply = apply;   // function apply(ctx) { … }
    exports.inject = inject; // 与 package.json dsh.client.inject 一致的数组
    return module.exports;
  }
});
```
- Host 半 `lib/index.js`：普通 ESM，`export const apply = (ctx) => {…}` + `export const inject = [...]`（Host 侧 inject：`webServer`、`credentials`、`subprocess`）。

### 2.4 解析与安装（桌面版真实路径）

- loader 以 **profile 目录为 baseUrl** 解析 `name`（`cordis-plugin-loader/lib/index.js` `import(name, ctx.baseUrl)`；`dsh/lib/profile-boot-*.js` "anchor baseUrl at the profile directory"）。
- 桌面版安装 = 把包放进 **`~/.dsh/profiles/node_modules/<name>/`**（hoisted 树；`dsh-app-boot` 的 `healProfilesModuleFallback` 每次启动只把 App 自带依赖链 symlink 进去，**不删除第三方包**）+ 在 **`~/.dsh/profiles/web/cordis.patch.yml`** 追加 §2.2 的 insert → 重启 App。
- CLI 版等价命令：`dsh plugin --profile web add dsh-realtime-voice`。
- client-modules（`@deepseek-ai/dsh-client-modules`）扫描 loader 条目中声明 `dsh.client` 的包，组合 `window.__DSH_BOOT__` 并服务 `/plugins/dsh-realtime-voice/client.js`——**自定义路由路径避免占用 `/plugins/<id>/client.js` 与 `/api`**。

---

## 3. Client 取得当前 sessionId

- `conversation.input.right` / `.dock` 的 owner share 是 `InputZone = { session: ConversationSnapshot; input: InputState }`（`dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts` L326-329），**owner 里没有 sessionId**；slot 文档明言 "sessionId and the snapshot hook arrive as framework-standard props"（同文件 L332-333）。
- 正确来源：slot 组件的 **framework session kit**——`sessions.provide` 提供的 `useSession`/`useInput` 等（同文件 L281-282 注释），组件内取当前会话 id。
- 备选（非组件上下文）：`@deepseek-ai/dsh-client-runtime` 的 `scopeOf(ctx): SessionId | undefined`（`lib/types/client/agents/scope.d.ts`）读最近 agent tag（session id === agent id）。
- **待 PoC**：标准 kit 具体 hook 的准确名字/返回形状（`useSession` vs 其他），以 `dsh-client-ui-model-selection` 的 `ModelSelect` 组件实现为参照先例。

---

## 4. 捕获 RpcResponse.rpcId 的完整流程（强制用 carrier 面）

```ts
// inject: ['connection', …]
const res = await ctx.connection.api.sessions.prompt(
  { sessionId, mode: 'queue', content: [{ type: 'text', text: taskText }] },
  signal?,                                  // 可选 AbortSignal
);
if (!res.result.ok) throw new Error(`${res.result.error.code}: ${res.result.error.message}`);
const myRpcId = res.rpcId;                  // ← 本请求唯一关联锚点（RpcResponse 回显）
```
- `RequestPayload<'session.prompt'> = { sessionId; mode: 'queue' | 'steer'; content: PromptContentPart[]; clientTimeZone?: string }`（`dsh-host-apiproxy/lib/types/api/sessions.d.ts` L365-376）。`PromptContentPart = { type:'text'; text } | { type:'image'; … }`。
- `mode` 映射 1:1：`queue→followup`（新 turn、独占）、`steer→steer`（插入当前 step）——**delegate 只用 `queue`**。
- Host 把**同一个 carrier-minted rpcId** 嵌入 `user/message` 事件的 `source`（`sessions.d.ts` L40-55 的 `'user-rpc'` merge：`{ kind:'user'; rpcId; clientTimeZone? }`，"the client uses it to reconcile the optimistically echoed provisional message with the event stream"）。
- ⚠️ 不得用 `ctx.remote.session.prompt` 或 session facade 的 `prompt` 捕获 rpcId——两者都只返回 `RpcResult`（rpcId 被剥，见 §1.2 证据）。

---

## 5. session/queue：rpcId → itemId 映射 与 QueueAction.remove

- 帧：mux 流里的 `{ type: 'session/queue'; sessionId; items: QueuedInboxItem[] }`（`dsh-host-apiproxy/lib/types/api/events.d.ts`）。
- `QueuedInboxItem = { id: MessageId; placement: 'queued' | 'steering' | 'context'; message: Message }`；pending 消息的 `source` 即带 rpcId 的 `user-rpc` 来源 → **匹配 `item.message.source.rpcId === myRpcId` 得 `item.id`**。
- `QueueAction`（`sessions.d.ts` L164-167）：
  ```ts
  export type QueueAction =
    | { kind: 'edit'; content: ContentBlock[] }
    | { kind: 'remove' }        // ← 定向删除
    | { kind: 'steer' };
  ```
- `ctx.connection.api.sessions.updateQueue({ sessionId, itemId, action: { kind: 'remove' } })` → `RpcResponse<{ accepted: true }>`（L389-395）。
- 时序：item 只在**仍 pending**（未 claim）时存在于快照；已被 agent claim 后消失，remove 会得到 `queue-item-not-found`（按官方 UI 惯例收敛为静默 no-op，见 `dsh-client-ui-conversation/lib/client.js` "steer-unavailable / queue-item-not-found converges silently" 注释）。

---

## 6. user/message → turn/end → assistant/message 完成关联规则

事件类型（`@deepseek-ai/dsh-session/lib/types/types.d.ts` L223+，seq 连续）：
- `'turn/start': { turn }` / `'turn/end': { turn; reason: TurnEndReason }`
- `'user/message': UserMessage`（含 `source.rpcId`）
- `'assistant/message': { turn; step; message: AssistantMessage; usage?: TokenUsage }`
- `TurnEndReasonMap`（L135-167）：`completed` | `aborted{reason: TurnEndCancelCause}` | `blocked` | `error{error: LlmFailure}` | `max-tokens` | `interrupted`

关联算法（queue 模式 + 单 delegate 串行化前提下）：
1. 开自己的 mux：`ctx.connection.api.events.mux({}, signal)`（`IApiClient.events.mux`，`client.d.ts`）；以 `session/subscribed.lastSeq` 为基线。
2. 维护"当前 open turn"= 最近一个无配对 `turn/end` 的 `turn/start`。
3. 收到 `session/event` 且 `event.type === 'user/message'` 且 `event.data.source.rpcId === myRpcId` → 该时刻的 open turn 即 **delegate turn N**；记录 `event.seq`。
4. 等 seq 之后的 `turn/end`（turn === N）：终态判定 reason；`completed` 为成功；`aborted/error/max-tokens/blocked` 为失败/取消。
5. 最终回复 = 该 turn 内**最后一个** `assistant/message`（turn === N）。

---

## 7. active / pending delegate 的取消状态机

状态：`PENDING_QUEUED`（placement `'queued'`）｜ `PENDING_STEERING`（`'steering'`）｜ `ACTIVE`（已 claim：`session/queue` 中已无该项，且 mux 已见带 myRpcId 的 `user/message`）｜ `DONE` ｜ `CANCELLED`

| 当前状态 | 取消动作 | 理由 |
|---|---|---|
| PENDING_* | `updateQueue({…, action:{kind:'remove'}})`（**禁止** `session.cancel`） | `session.cancel` 停 active turn，会误伤正在跑的用户任务 |
| ACTIVE | `session.cancel({ sessionId })`（`ctx.connection.api.sessions.cancel`，L401-405） | 此刻 active turn 就是 delegate（queue FIFO + 单 delegate 串行），安全；RPC 语义为 keepInbox：pending 队列保留 |
| remove 时 `queue-item-not-found` | 视为 ACTIVE，回退 `session.cancel` | claim 竞态收敛 |
| 任意状态 | 模型侧 `response.cancel`（provider 层，停说话） | 与 Harness 取消相互独立 |

- 取消结果识别：`turn/end(reason.kind === 'aborted')`。
- **硬约束：同 session 同时只允许一个 voice delegate**（第二个在 PENDING/ACTIVE 期间直接拒绝）——否则"下一个 turn/end"归属二义。

---

## 8. webServer.register 路由与 disposer

```ts
export const inject = ['webServer', 'credentials', 'subprocess'];
export function apply(ctx) {
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-realtime-voice/sdp',
      handler: async (req, res) => { /* 读 body → 换 Answer SDP → res 写回 */ },
    });
    return dispose;                       // 插件卸载自动移除
  }, 'dsh-realtime-voice: sdp route');
}
```
- `register` 返回 disposer（`() => void`），重复 (kind,path) 会 throw；`registerUpgrade` 用于 WS 音频管道（handler 持有 socket）。
- 客户端与 webserver **同源**（`app.asar/lib/main.js` L413-415 `loadURL(rendererUrl)`），自建路由可被直接 fetch/WS，无 CORS；`/api` 的 trust fence 只作用于该前缀，不影响自建路径。
- handler 拥有完整响应生命周期（可挂起做 SSE）；upgrade handler 拥有 socket 生命周期。

---

## 9. credentials.resolve 正确用法

```ts
import { credentialRef } from '@deepseek-ai/dsh-credentials';
const cred = await ctx.credentials.resolve(credentialRef('DASHSCOPE_API_KEY')); // 或 'OPENAI_API_KEY'
if (!cred) { res.writeHead(502); res.end('credential unconfigured'); return; }
// cred.value 仅用于本次请求；不要跨请求缓存（文档：consumers re-resolve at each operation）
```
- `ResolvedCredential = { value: string; source: string }`（source 层：`env`/`file`/`project-env`/`user-env`）。
- 空值 = 未配置（resolve 返回 undefined），绝不把空串当密钥。
- 配置面只存引用、永不落值：env 或 `~/.dsh/.credentials.yaml`（写入路径由 CLI/UI 负责；插件只 `resolve`）。**待 PoC**：DASHSCOPE_API_KEY 经 Models 页写入时的确切 ref 名与落盘行为（对插件只读无影响）。

---

## 10. conversation.input.right / conversation.input.dock 注册

```ts
// 浏览器半 apply(ctx) 内（照抄 dsh-client-ui-model-selection/lib/client.js L754-783 模式）
ctx.inject(['slots', 'sessions'], (scope) => {
  scope.slots.inject('conversation.input.right', () => scope.slots.register({
    name: 'conversation.input.right',     // 键必须等于槽位名
    locale: NS,
    inject: (sessionId) => ({ /* 组件注入面：连接状态、开始/停止、cancel 等 */ }),
  }, MicButton));

  scope.slots.inject('conversation.input.dock', () => scope.slots.register({
    name: 'conversation.input.dock',
    locale: NS,
    inject: (sessionId) => ({ /* 状态文本：空闲/聆听/执行中/已取消 */ }),
  }, VoiceStatus));
});
```
- 两个槽位均为 `{ kind: 'list'; scope: 'session'; owner: InputZone }`（slots.d.ts L190-193 / L228-232）；`InputZone = { session: ConversationSnapshot; input: InputState }`（L326-329）。
- owner share 只读快照，不要 subscribe；sessionId 从框架标准 kit 拿（§3）。

---

## 11. Qwen / OpenAI Provider 共同事件语义（DataChannel `oai-events`，两端同协议）

**Client → Server**：`session.update`（modalities / turn_detection / instructions / tools）、`response.create`、`response.cancel`、`input_audio_buffer.append/.commit/.clear`、`conversation.item.create`（`item.type: 'function_call_output'`，含 `call_id`）。
**Server → Client**：`session.created/.updated`、`input_audio_buffer.speech_started/.stopped`、`conversation.item.created`（`type:'function_call'` 带 `call_id/name/arguments`；或 message item）、`response.created/.done`、`response.audio_transcript.delta/.done`。

- **function-call 往返**（两端一致）：`function_call` 事件 → 执行 → `conversation.item.create({item:{type:'function_call_output', call_id, output}})` → **`response.create`**（工具场景必须显式触发；VAD 普通对话才自动生成）。
- **取消**：只有 `response.cancel`；**两端都没有 `session.cancel`**（阿里云客户端事件全集 6 个、OpenAI 同协议）。
- WebRTC：`RTCPeerConnection({iceServers: []})`；媒体门控 `replaceTrack(null)` 直到 `session.created`；Answer SDP 需 `\r\n` 规范化（官方示例 `normalizeSdpForSetRemote`）。
- Provider 差异（参数化点）：
  - Qwen：endpoint `POST https://{endpoint}/api/v1/webrtc/realtime?model=qwen3.5-omni-plus-realtime`，`Content-Type: application/sdp`，`Authorization: Bearer $DASHSCOPE_API_KEY`（Host 代理；WebRTC 仅 server/semantic VAD）。
  - OpenAI：`POST https://api.openai.com/v1/realtime/calls`，**multipart 透传**（保留原 Content-Type），`Authorization: Bearer $OPENAI_API_KEY`（官方 canonical 代理形态，见 openai/realtime-voice-component docs/authentication.md；client_secret 是 legacy 路径，不用）。

---

## 12. 无需真实 Key 的验收矩阵 + mock 清单

### 12.1 官方测试面
- Client：`@deepseek-ai/dsh-client-connection` 提供 **`createFixtureApi(options)` / `createFixtureFaces(options)`**（`lib/types/client/fixture.d.ts`）——内存假 Host、无网络；`FixtureOptions` 含 `rejectPrompt` 等分支。connection 插件按页面 URL 选择 fixture 或真实 HTTP 传输（"decided at boot from the page URL"）。
- Host：credentials 走 env（`credentialRef` 解析 env 即返回，无需真 key）；SDP 路由的网络调用在 **VoiceProvider.exchangeSdp** 接口处 mock（单元测试层面替换实现，不产生真实网络请求）。

### 12.2 验收矩阵（全部无真实 Key）

| # | 验收项 | 判定 | 关联契约 |
|---|---|---|---|
| A1 | 包装入 rc.5 web profile：inventory 出现 `dsh-realtime-voice`（active），`/plugins/dsh-realtime-voice/client.js` 可 fetch | 200 + 模块表含 id | §2 |
| A2 | 麦克风按钮渲染于 `conversation.input.right`；状态行渲染于 `.input.dock`；无 session 时无报错 | 快照/截图 + console 干净 | §10 |
| A3 | mock provider：connect → `session.created` → 门控释放 → 远端音频轨道存在（ontrack） | 事件序列断言 | §11 |
| A4 | delegate 流：mock `function_call` → 发起 `ctx.connection.api.sessions.prompt(mode:'queue')` → **`res.rpcId` 已捕获** → 事件流见 `user/message.source.rpcId === rpcId` → `turn/end(completed)` → 取最后 `assistant/message` → `function_call_output` + `response.create` | 全链路断言 | §4,§6 |
| A5 | pending 取消：delegate 入队 → `session/queue` 帧含 `source.rpcId` 匹配项 → `updateQueue(remove)` → 项消失；**断言未调用 session.cancel** | 调用记录 | §5,§7 |
| A6 | active 取消：mock 活跃 turn → `session.cancel` 被调用 → `turn/end(aborted)` 观测到 | 调用记录 + 事件 | §7 |
| A7 | 串行化：第一个 delegate PENDING 时第二个被拒 | 拒绝错误 | §7 |
| A8 | SDP 路由：无凭据 → 502；假凭据（env 假值）→ 路由转发到 mock exchangeSdp 返回 canned Answer；错误 ref → 502 | 状态码 | §8,§9 |
| A9 | 路由生命周期：插件 dispose → 路由 404；重挂可再注册 | HTTP 探测 | §8 |
| A10 | VoiceProvider：fake Qwen 与 fake OpenAI 均满足 §11 事件语义，同一 Harness 桥接流对两 provider 差分通过 | 差分测试 | §11 |
| A11 | 凭据空值视为未配置（`resolve` → undefined → 502） | 单元 | §9 |
| A12 | prompt mode 透传 1:1（queue→send、steer→steer）；delegate 永不发 steer | 调用参数断言 | §4 |

### 12.3 mock 清单
1. `MockVoiceProvider`（实现 `VoiceProvider` 8 成员，事件脚本可编程：session.created、function_call、turn 完成等）。
2. `FakeCredentials`（host 测试组合里以 env 假值驱动真实 credentials-local，或替换 provider——**待 PoC**：第三方 host 插件能否替换 credentials 服务（duplicate-service 会 throw），若不能则只用 env 假值路径）。
3. fixture client（`createFixtureApi`）驱动 UI 层集成测试。
4. 事件脚本驱动器：`user/message(source.rpcId)` → `turn/end` 顺序可注入，验证 §6 关联算法的边界（steer 混入、无配对 turn/end、error reason）。

---

## 待 PoC 清单（实现前必须最小实验确认，不得猜）
1. Client framework session kit 取 sessionId 的准确 hook 名/形状（§3）。
2. `conversation.input.dock`/`.right` 的 `slots.register` 在纯第三方包中与官方组件共存的行为（顺序/优先级/重复 key 冲突）——照抄 model-selection 模式仍建议 PoC 一次。
3. `ctx.subprocess.spawn` 对"插件自带 helper 绝对路径 + 持续 stdout 管道"在桌面沙箱（workspace-write）下是否被拦；若被拦，回退 `ctx.shell.start` 或需在文档注明授权前提（§1.1）。
4. 第三方 host 插件能否注册 credentials provider（§12.3），否则测试只走 env 假值。
