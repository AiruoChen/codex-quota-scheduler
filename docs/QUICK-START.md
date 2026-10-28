# Codex 任务助手：用户使用手册（简明版）

适用：Windows 64 位客户端。按下面顺序操作即可。

## 1. 下载并打开

1. 打开[项目下载页](https://github.com/AiruoChen/codex-quota-scheduler/releases)，在 **Assets（附件）** 中下载 Windows 客户端。
2. 下载的是安装包（`setup.exe`）：双击安装，再从桌面打开。
3. 下载的是便携 ZIP：右键选择“全部解压”，打开解压后的文件夹，双击 **`CodexQuotaScheduler.exe`**。保留整个文件夹。

**下载页没有附件时，请向项目提供者索取客户端包。** `Code → Download ZIP` 是源码，不能直接双击运行。

## 2. 连接自己的 Codex 账户（首次使用）

1. 按[官方说明](https://learn.chatgpt.com/docs/codex/cli)安装 **Codex CLI**；已经安装的跳过此步。
2. 按 **Win + R**，输入 `powershell` 并回车。在打开的窗口输入 `codex login`，回车后按浏览器提示登录自己的 ChatGPT 账户。[官方登录说明](https://learn.chatgpt.com/docs/auth)
3. 打开本助手的“设置与帮助”：配置项选择 **`provider`**，值填写 **`codex`**，点击“保存配置”。
4. 点击顶部“后台服务 → 重启自有后台…”，按提示确认。
5. 回到“运行概览”，点击“查询额度”。看到自己的账户和真实额度后继续。

如果仍显示“模拟模式”，请先检查第 3、4 步；模拟模式不能执行真实任务。
