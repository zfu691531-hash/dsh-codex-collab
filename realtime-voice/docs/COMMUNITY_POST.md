# DSH｜dsh-realtime-voice｜让语音厂商负责听说，Harness 负责推理与插件调度

> 非官方项目，由社区成员独立开发和维护。

项目地址：
https://github.com/zfu691531-hash/dsh-codex-collab/tree/main/realtime-voice

## 项目介绍

`dsh-realtime-voice` 是一个轻量的 DeepSeek Harness 实时语音插件，不带 Docker、Python 或本地模型。

国内线路使用 `Qwen ASR → DeepSeek Harness → Qwen TTS`。千问只负责流式识别和播音；用户确认发送后，推理、上下文、联网、工具和其他插件调度仍由当前 Harness 会话完成。ASR 文本统一进入 Harness 原生输入框，避免在运行队列、调整方向和草稿之间拆句或丢句。

插件通过标准 `dsh.bundle` manifest 安装：Host 侧代理上游语音 WebSocket 并从 Harness 凭据服务读取 API Key，浏览器侧只处理麦克风、VAD、原生输入框和流式播放。Key 不进入浏览器、本地存储、包文件或日志。

## 安装

GitHub Release 提供预构建 tarball，不需要允许 git 依赖执行构建脚本：

```bash
curl -L -o dsh-realtime-voice-0.7.0.tgz \
  https://github.com/zfu691531-hash/dsh-codex-collab/releases/download/voice-v0.7.0/dsh-realtime-voice-0.7.0.tgz
dsh plugin --profile web add ./dsh-realtime-voice-0.7.0.tgz
```

重启 Harness 后，在“设置 → 插件”配置“实时语音（千问 / GPT）”。千问需要在 Harness 凭据中提供 `DASHSCOPE_API_KEY`，并填写同区域的百炼 Workspace ID。

## 截图

![DeepSeek Harness 实时语音插件设置](https://raw.githubusercontent.com/zfu691531-hash/dsh-codex-collab/main/realtime-voice/screenshots/settings.png)

## 验证与边界

- 44 项 Host、协议、委派、并发、TTS 和摘要边界测试通过。
- 已验证千问 ASR/TTS 的真实 WebSocket 握手。
- 当前 Harness Desktop 的 Electron 壳拒绝 renderer 麦克风权限，因此插件会在默认外部浏览器打开同一 loopback Harness 页面；会话和 Agent 仍是同一个 Harness 实例。
- 项目为 MIT 许可，与 DeepSeek AI、阿里云或 OpenAI 无隶属关系。

下一阶段正在设计自适应“对话接场器”：简单问题直接播结果；深任务超过实际等待阈值后，先播放一句不虚构结果的自然承接，再在 Harness 结果到达时于安全语音边界接上。该功能仍是路线图，不属于 0.7.0 的已发布能力。
