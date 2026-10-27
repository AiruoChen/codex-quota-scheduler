# 最小桌面客户端

已完成需求阶段 A：技术选型、独立窗口、模拟环境、后台连接、基础单实例、安全退出和 Windows x64 便携打包。
页面复用现有控制台；GUI 模块化、托盘、通知、安装器、开机启动及自动更新由后续模块实施。
选型见 [技术决策](DESKTOP-TECH-DECISION.md)，完整目标见 [桌面需求](DESKTOP-CLIENT-REQUIREMENTS.md)。

## 源码运行

开发机需要 Node.js 22.12+，在项目目录运行：

```powershell
npm.cmd ci --ignore-scripts
node node_modules/electron/install.js
npm.cmd run desktop
```

显式运行官方 Electron 安装脚本用于下载固定版本的运行时；构建机需要访问 npm 与 Electron 官方发布资源。
指定独立数据目录或已有配置：

```powershell
npm.cmd run desktop -- --data-dir ".local/desktop-profile"
npm.cmd run desktop -- --config "config/local.json"
```

相对路径按启动命令的工作目录解析；个人路径不会写入源码。--config 必须指向有效已有配置，不自动导入或复制旧数据。
默认数据目录为系统当前用户 appData 下的 CodexQuotaScheduler，与源码和安装目录分离。
同一数据目录只启动一个窗口；再次启动会唤起既有窗口，不切换其配置。不同数据目录属于独立实例。

## 打包与运行

在 Windows x64 构建机运行：

```powershell
npm.cmd run package:desktop
```

生成 `.release/desktop/CodexQuotaScheduler-win32-x64/`，复制整个目录后双击 `CodexQuotaScheduler.exe`。
不能只复制 EXE，Chromium、Node 和程序资源位于同一目录；目标机器无需另装 Node.js/npm。
这是未签名的便携样包，暂不含安装器；再次打包前需将旧生成目录移走，脚本不会自动覆盖。

首次创建模拟配置、空任务和 SQLite 数据库，不发送真实任务。真实来源仍需可用的本机 Codex CLI 和登录状态；
客户端不收集登录凭据，不能绕过账户额度。现有页面操作见 [管理界面说明](MANAGEMENT.md)。

## 关闭和数据

本模块尚无托盘，关闭窗口会请求安全退出。自有后台先请求停止，等待实际结果保存后再关闭窗口，期间不能再操作。
取消未确认时仍保留 needs_attention，不宣称远端已取消。
--config 连接既有外部服务时，关闭窗口只断开连接，外部服务继续运行；窗口标题会标记连接已有服务。

默认数据结构：

```text
CodexQuotaScheduler/
  config/local.json         私人配置
  tasks.json                首次为空的任务导入清单
  data/state.sqlite         任务、快照和历史
  .runtime/<摘要>/          实例身份、控制密钥及轮转日志
  ...                      Electron 自身本地状态
```

后台服务重启后队列保持暂停。遗留状态需按 [恢复说明](RECOVERY.md)核对，不自动释放执行权。
损坏配置或数据库存在但缺少配置会阻止自动初始化，先保留数据并恢复有效配置。
外部配置继续使用原数据位置，不自动搬迁；个人数据不属于便携包，也不提交 Git。

## 验证

```powershell
npm.cmd run check
npm.cmd test
npm.cmd run demo
npm.cmd run smoke:desktop
node --experimental-sqlite scripts/smoke-desktop.mjs --packaged .release/desktop/CodexQuotaScheduler-win32-x64/CodexQuotaScheduler.exe
```

smoke 使用独立 `.local/desktop-acceptance-*`、模拟任务和临时回环调试端口，自动打开窗口并安全退出。
它清除子进程 PATH 中的 Node/npm，检查内置 SQLite、任务持久化、初始暂停、页面无 Node 权限、单实例与实例释放。
截图和不含控制密钥的结果摘要留在忽略目录。本机验证不等同于干净 Windows 虚拟机验收，也不替代真实任务验收。

2026-10-25 本机结果：严格检查通过，Node.js 22 下 188 项回归全部通过；Electron 内置 Node 下 23 项执行协议替身测试全部通过。
开发版与打包版交互验证均通过，0 页面脚本异常；另验证父进程退出后后台正常收尾。全部使用模拟环境，未发送真实任务。
