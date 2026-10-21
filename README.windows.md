# DSH Codex Collab 0.1.7 Windows 安装包

插件让 DSH 调用 Codex；同包 MCP companion 让 Codex 调用 DSH。

## 安装与检查

解压完整安装包。桌面版在 PowerShell 中运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -ProfileName desktop
powershell -ExecutionPolicy Bypass -File .\doctor.ps1 -ProfileName desktop
```

双击 install.cmd / doctor.cmd 仍默认使用 web profile。doctor 应输出 DSH_HTTP_OK auto session/list、MCP_COMPANION_OK 和 DOCTOR_OK。健康检查复用 companion 的认证、动态端口发现和只读 session/list，不再访问固定 3080。

已有配置用户升级插件时，先将新 TGZ 放到持久路径，使用 `dsh plugin --profile desktop add <TGZ绝对路径>`。仅升级 DSH 插件不需要运行完整安装器，也不需要修改已有 Codex MCP 配置。

desktop profile 会热加载插件安装和 `~/.dsh/profiles/desktop/cordis.patch.yml` 编辑，无需重启 DeepSeek Harness。等待工具重新注册后复测。热加载会释放旧的 app-server 和内存 taskId 映射，正在运行的任务应先完成；升级后重新 start，再 reply。Codex 若新增 MCP 配置，需要打开新的会话。

## pnpm 虚拟存储配置

在 `~/.dsh/profiles/desktop/.npmrc` 持久写入：

```ini
virtual-store-dir-max-length=60
```

已有 `node_modules/.modules.yaml` 的 virtualStoreDirMaxLength 应与该值一致，否则 pnpm 安装会报告配置不匹配。安装器会沿用已有 modules 文件中的值；.npmrc 则保证后续通过其他入口安装也使用相同设置。修改前先检查当前值，避免破坏已有 profile。

## codexCommand 自动解析

推荐在 desktop profile patch 中设置 `codexCommand: ''`，清除 0.1.6 的构建哈希固定路径。候选顺序：

1. 显式 codexCommand。
2. 环境变量 CODEX_BIN。
3. `%LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe`，逐个执行 --version，按 SemVer 取最高有效版本；alpha.10 高于 alpha.9，同版本稳定版高于预发布版。
4. PATH 中的绝对文件路径。
5. Windows App Execution Alias。

无效候选保留原因后继续；不硬编码哈希，每次插件加载重新扫描。Windows 不使用 `~/.codex/.sandbox-bin/codex.exe`，即使它通过配置、PATH 或符号链接出现也会被拒绝。codex_status.failures 同时列出候选顺序、来源、选择结果与失败原因。选中 CLI 后还会检查 app-server --help。

## 安全与恢复

- 只连接本机 HTTP loopback；默认 DshBaseUrl=auto，端口随 Harness 启动动态发现。可显式指定当前 loopback URL。
- TGZ 会复制到 `~/.dsh/packages/dsh-codex-collab/`，安装后可删除解压目录。目录内存在多个版本时 Windows 安装器选择最高版本。
- 安装前备份将修改的 Codex 配置；现有非安装器管理的同名 MCP 配置会触发冲突检查。
- 不同的同名 Skill 默认停止覆盖；使用 -ForceSkill 可先备份再替换。
- `install.ps1 -DryRun` 检查安装目标；uninstall.cmd 仅移除安装器管理的配置和未修改的 Skill，不删除会话或工作区。

## 0.1.7 复测

在 DSH 调用 codex_status，确认桌面 CLI 版本、路径与 failures 中的候选顺序；调用 codex_task_start 时传入真实 cwd，成功后再次 status，应返回 tasks[].codexCwd 且没有 undeclared property 报错。继续调用 codex_task_reply，确认同一个 threadId。此后更新 Codex 应用或更换构建目录，重新加载插件后仍应自动选择最高版本。
