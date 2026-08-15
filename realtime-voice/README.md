# dsh-realtime-voice

DeepSeek Harness 的轻量实时语音插件。不包含 Docker、Python或本地模型。千问线路是确定性的三段式管线：浏览器采集 PCM，Harness Host 以同源 WebSocket 代理专用 ASR/TTS；识别文本先统一写入 Harness 原生输入框，用户发送后由当前 Harness 会话处理，语音厂商没有独立回答的机会。

![DeepSeek Harness 实时语音插件设置](https://raw.githubusercontent.com/zfu691531-hash/dsh-codex-collab/main/realtime-voice/screenshots/settings.png)

## 能力

- 国内线路：`qwen3-asr-flash-realtime → DeepSeek Harness → qwen3-tts-flash-realtime`（阿里云百炼，北京/新加坡）。
- 全球线路：`gpt-realtime-2.1`（OpenAI Realtime）。
- 千问使用两个独立语音模型：ASR 只转写，TTS 只播报；不再使用 Omni Realtime 作为对话模型。
- 所有 ASR final 只追加到原生输入框，不直接调用 `sessions.prompt`，因此同一段话不会一部分进入“调整方向”队列、另一部分留在草稿。用户点击原生发送后，推理、记忆、联网、插件与工具调度全部由 Harness 完成。
- VAD 默认 `threshold=0.85`、尾静音 `700ms`，并关闭浏览器自动增益以优先近讲。ASR final 先进入候选断句，再等待 `1200ms` 的续说窗口；从停顿开始约 `1.9s` 才提交 Harness，期间继续说话仍属于同一轮。
- 严格的 `TurnCoordinator` 为每轮分配唯一 ID，并串行处理 ASR 状态事件；旧轮的迟到回调不能再启动 Harness、覆盖新轮或播放过期语音。
- Harness 执行工具期间，普通背景转写不会再取消当前任务；只有明确说“停止 / 取消 / 算了”才会中止。
- 无论 Harness 正在推理、TTS 正在播报还是已经恢复监听，新语音都只追加到原生输入框；用户点击原生“发送”后才作为下一轮统一处理。
- 语音模式开启期间，插件旁路观察用户手动提交的原生 Harness turn，流式提取口语摘要并交给 TTS；不需要插件再次提交相同消息。
- TTS 使用 24kHz PCM 流式播放。播报期间麦克风音频先留在浏览器本地，不会直接污染云端 ASR；经过播放预热且检测到至少 `500ms` 持续近讲后，才暂停播放器并把带预卷的候选音频交给 ASR。
- 候选插话经过文本有效性与播报回声相似度复核；误触发会恢复原播报，确认插话才停止 TTS。插话文字只进入原生输入框，等待用户发送或清空，不会自动抢开第二个 Harness 任务。
- TTS 播放结束后保留 `400ms` 防回声窗口，清理残留 ASR 缓冲后才重新进入监听。
- 实时语音轮次要求 Harness 先流式输出 1–2 句口语摘要，再继续完整结果；插件在摘要每个完整句子生成时立即提交 TTS，不等待详细正文或 `turn/end`。TTS 只接受 `text-delta` 中受边界标记保护的摘要，绝不播报 `reasoning-delta`、工具过程或详细正文。
- 同一会话只允许一个语音委派。排队任务使用定向删除，运行中任务才会取消当前 turn，避免误伤原有工作。
- API Key 只由 Host 的凭据服务按请求读取，不写入浏览器、`localStorage`、包文件或日志。

## 安装

推荐从 GitHub Release 安装预构建包，不需要允许 git 依赖执行 `prepare`：

```bash
curl -L -o dsh-realtime-voice-0.7.0.tgz \
  https://github.com/zfu691531-hash/dsh-codex-collab/releases/download/voice-v0.7.0/dsh-realtime-voice-0.7.0.tgz
dsh plugin --profile web add ./dsh-realtime-voice-0.7.0.tgz
```

重启 DeepSeek Harness 后，在“设置 → 插件”展开“实时语音（千问 / GPT）”。

也可以从源码自行验收并打包：

```bash
npm install --ignore-scripts
npm run dev:link-dsh
npm run check
npm pack
```

源码构建需要本机已安装 DeepSeek Harness；`dev:link-dsh` 只把类型检查和打包所需的 Harness 包链接进当前开发目录。普通用户安装 Release tarball 不需要执行这一步。

## 配置

在 Harness 的凭据配置中提供所选线路的引用：

- 千问：`DASHSCOPE_API_KEY`，并在插件设置里填写同区域的百炼 Workspace ID。
- OpenAI：`OPENAI_API_KEY`。

插件设置只保存 provider、Workspace ID、ASR/TTS 模型、TTS 音色、VAD 参数和播报风格；不保存 Key。千问默认使用北京区、`qwen3-asr-flash-realtime`、`qwen3-tts-flash-realtime` 和 `Chelsie`；OpenAI 默认使用 `gpt-realtime-2.1` 和 `marin`。`Tina` 是 Omni 专属音色，独立 TTS 不支持；`Chelsie` 是专用 TTS 中更接近其软糯亲昵风格的选择。

## 桌面版 rc.5 的麦克风限制

当前 DeepSeek Harness Desktop rc.5 的 Electron 壳会拒绝 renderer 的麦克风权限。插件在桌面窗口点击话筒时会用默认外部浏览器打开同一个 loopback Harness 页面；在 Chrome/Edge 中授权麦克风后即可使用。Host、会话和插件仍是同一套 Harness 实例，不会接入 Sophie 或另起 Agent 服务。

未来桌面壳开放麦克风权限后，这个插件无需音频架构变更即可直接在内嵌窗口工作。

## 开发与验收

```bash
npm install --ignore-scripts
npm run dev:link-dsh
npm run check
```

`npm run check` 包含类型检查、无真实 Key 的 Host/委派/双 provider 协议测试、生产构建和浏览器 bundle 纯度检查。

详细 rc.5 契约见 [`docs/HARNESS_RC5_CONTRACT.md`](docs/HARNESS_RC5_CONTRACT.md)。

下一阶段的自适应“对话接场器”设计见 [`docs/ADAPTIVE_FLOOR_MANAGER.md`](docs/ADAPTIVE_FLOOR_MANAGER.md)。它是路线图，不属于 0.7.0 的已发布能力。

## 安全边界

- HTTP 与 WebSocket 路由仅接受 loopback、同源请求；百炼 Key 只在 Host 到上游的握手请求中出现。
- Qwen Workspace ID 和区域使用 allowlist 校验，不能注入任意上游域名。
- 上游错误最多返回截断后的非敏感文本，不返回凭据。
- OpenAI API 的可用地区和账户使用须遵守其服务条款；插件不实现或配置网络规避功能。
