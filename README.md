# DSH Community Plugins

这个仓库维护两套可以独立安装、也可以组合使用的 DeepSeek Harness 社区插件：

- [`plugin/`](plugin/)：DeepSeek Harness 与 Codex 的本机双向协作插件，支持 macOS 和 Windows。
- [`realtime-voice/`](realtime-voice/)：轻量实时语音插件，使用千问或 OpenAI 完成流式 ASR/TTS，所有推理、记忆、工具与插件调度仍由当前 Harness 会话完成。

> 非官方社区插件，与 DeepSeek AI 或 OpenAI 无隶属关系。适配 DeepSeek Harness developer preview，后续版本可能需要跟随上游破坏性变更调整。

## 实时语音

实时语音包不会在本机部署模型，也不会把千问 Omni 当成第二个对话 Agent。国内线路采用 `Qwen ASR → DeepSeek Harness → Qwen TTS`，转写统一进入 Harness 原生输入框，用户发送后才进入当前会话；完整能力、安装和配置说明见 [`realtime-voice/README.md`](realtime-voice/README.md)。

当前稳定包：`dsh-realtime-voice 0.7.0`。GitHub Release 提供预构建 tarball，安装时不需要授权执行第三方构建脚本。

“嘴巴接场、脑子思考”的自适应低延迟方案正在设计中，架构与安全边界见 [`realtime-voice/docs/ADAPTIVE_FLOOR_MANAGER.md`](realtime-voice/docs/ADAPTIVE_FLOOR_MANAGER.md)。该能力尚未包含在 0.7.0，文档不会把路线图误写成已发布功能。

## Codex 协作能力

- DSH → Codex：检查状态、创建 Codex task、续接同一 task。
- Codex → DSH：创建、续接、查询和取消 DSH session。
- 使用 stdio app-server/MCP 与 DSH loopback Host API，不创建公网服务。
- 安装 Codex `dsh-collab` Skill，在用户明确要求协作时触发。

核心插件包为 `dsh-codex-collab-0.1.4.tgz`。macOS 适配层会自动定位 Homebrew、ChatGPT/Codex App 和命令行工具，并把 Codex 的绝对路径写入 DSH profile，避免从 Finder 启动 Harness 时丢失终端 PATH。DSH → Codex 改用[官方 app-server](https://developers.openai.com/codex/app-server/)，因此委派任务会显示在 Codex Desktop 正常任务列表中；Codex companion 仍会自动发现 Harness 桌面版的动态 Host 端口，无需固定 `3080`。

## macOS

要求：

- DeepSeek Harness 及 `dsh` CLI
- ChatGPT/Codex App 或可用的 `codex` CLI
- Node.js

安装前检查，不修改系统：

```bash
./install.sh --dry-run
```

安装：

```bash
./install.sh
```

安装后重启 DeepSeek Harness 和 Codex，再运行：

```bash
./doctor.sh
```

也可以在 Finder 中双击 `install.command`、`doctor.command` 和 `uninstall.command`。

卸载：

```bash
./uninstall.sh
```

## Windows

Windows 安装方式保持不变：

1. 双击 `install.cmd`。
2. 重启 DeepSeek Harness 和 Codex。
3. 双击 `doctor.cmd`，确认出现 `DOCTOR_OK`。

原始 Windows 说明保存在 [`README.windows.md`](README.windows.md)。

## 安装范围

安装器会管理以下内容：

- `~/.dsh/packages/dsh-codex-collab/`：稳定插件包副本。
- `~/.dsh/packages/dsh-codex-collab/launch-dsh-collab.mjs`：macOS 动态 Host 发现器。
- `~/.dsh/profiles/<profile>/node_modules/dsh-codex-collab/`：DSH 插件。
- `~/.dsh/profiles/<profile>/cordis.patch.yml`：带标记的 Codex 可执行路径配置。
- `~/.codex/config.toml`：带标记的 `dsh-collab` MCP 配置。
- `~/.codex/skills/dsh-collab/SKILL.md`：协作触发 Skill。

配置修改前会生成 `.dsh-codex-collab.bak`。如果发现同名但不受安装器管理的配置或 Skill，安装会停止；使用 `--force-skill` 才会备份并替换冲突 Skill。

## 使用

在新 Codex task 中说：

> 和 DSH 协作完成这个任务。

在 DSH 中说：

> 把这个任务交给 Codex，并在同一任务里继续协作。

## 边界

- companion 只接受 loopback 地址；macOS 默认使用 `DSH_BASE_URL=auto` 动态发现 Harness Host。
- 当前不桥接 Codex/DSH 的交互式审批与提问。
- DSH → Codex 的 task/thread 映射保存在内存中，DSH 重启后丢失。
- npm 发布包只包含运行所需编译产物；仓库中的 `plugin/` 保留可维护的 TypeScript 源码。

## 社区发现

仓库使用 DeepSeek Harness 官方推荐的 [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic。社区展示帖遵循官方 “Show Your Plugins!” 分类规范；两套插件均为社区成员独立开发和维护的非官方项目。DeepSeek Harness 官方项目及社区入口见 [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness)。

## License

MIT
