# DSH Codex Collab Windows 一键安装包

这个 ZIP 同时安装两端：

- DeepSeek Harness 原生插件：让 DSH 调用 Codex。
- Codex 全局 MCP companion 和触发 Skill：让新 Codex 会话调用 DSH。

## 安装

1. 解压整个 ZIP，不要只打开压缩包内部运行。
2. 双击 `install.cmd`。
3. 安装成功后重启 DeepSeek Harness 和 Codex。
4. 双击 `doctor.cmd`，看到 `DOCTOR_OK` 即完成。

之后可在新的 Codex 会话直接说：

> 和 DSH 协作完成这个任务。

也可以在 DSH 会话中说：

> 把这个任务交给 Codex，并在同一任务里继续协作。

## 安全与恢复

- 只连接本机 `127.0.0.1:3080`，不创建公网服务。
- 插件 TGZ 会复制到 `~/.dsh/packages/dsh-codex-collab/`，解压目录之后可以删除。
- 安装可重复执行。
- 已有 profile 若由不同 pnpm/DSH 版本创建，安装器会读取 `.modules.yaml` 中的 virtual store 长度，并只在当前 DSH/pnpm 调用期间传入该值，避免 `ERR_PNPM_VIRTUAL_STORE_DIR_MAX_LENGTH_DIFF`。
- Codex 配置修改前会生成 `config.toml.dsh-codex-collab.bak`。
- 如果已有同名但非本安装包管理的 MCP 配置，安装器会停止，不会覆盖。
- 如果已有不同的 `dsh-collab` Skill，默认停止；需要替换时运行 `install.ps1 -ForceSkill`，原 Skill 会先备份。
- 某一步失败后可以修复提示的问题并重新运行，不会回滚或删除已经存在的其他插件。
- 如需只检查安装目标而不修改系统，可运行 `install.ps1 -DryRun`。

## 卸载

双击 `uninstall.cmd`。卸载器只删除由本安装包管理的 MCP 配置和未被修改的 Skill；不会删除 DSH/Codex 会话或工作区文件。
