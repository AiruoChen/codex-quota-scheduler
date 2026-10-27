# 桌面客户端与后台生命周期

已完成最小客户端及后台生命周期管理：独立窗口、模拟环境、受控启动/重启/停止、外部服务归属、等待/取消退出和 Windows x64 便携打包。
GUI 基础框架、概览、任务与队列、运行记录与异常处理已完成，六个页面按模块组织；托盘与通知已完成；配置/帮助向导、安装器、开机启动及自动更新继续分块实施。
额度查看、离线重连及模块说明见 [GUI 基础框架与运行概览](DESKTOP-GUI.md)。
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
也可以构建到新的生成目录，保留已有客户端：`npm.cmd run package:desktop -- --output-name desktop-lifecycle`。
该命令生成 `.release/desktop-lifecycle/CodexQuotaScheduler-win32-x64/`；命名仅允许字母、数字、横线与下划线。

首次创建模拟配置、空任务和 SQLite 数据库，不发送真实任务。真实来源仍需可用的本机 Codex CLI 和登录状态；
客户端不收集登录凭据，不能绕过账户额度。现有页面操作见 [管理界面说明](MANAGEMENT.md)。

## 关闭和数据

菜单“后台服务 → 服务状态”打开独立状态窗口，显示当前服务归属、阶段、活动操作和错误原因。
连接失败会保留状态窗口，可重试或明确核对已退出的服务记录，不会关闭客户端后悄悄重发任务。

关闭窗口默认隐藏到托盘，首次会显示说明；后台任务与派发状态保持原样。托盘提供打开窗口、服务状态与通知记录、暂停派发和安全退出。
托盘不可用时保留操作窗口。详见 [托盘与通知](DESKTOP-TRAY-NOTIFICATIONS.md)。
显式安全退出时，自有后台存在活动操作可选择“留在托盘”“等待完成后退出”“请求取消后退出”。
留在托盘保持工作；等待式退出先暂停并阻止新操作，不中断当前任务；取消式退出等待准确回合的终止确认。
等待期间可明确改为请求取消，不能在已开始停止后撤销为继续派发。取消未确认仍保存 needs_attention。
显式退出且没有活动操作时直接安全退出；退出前等待后台操作、HTTP 请求、结果及通知状态保存完成。

“重启自有后台”需要确认，旧后台完全结束后才加载保存后的配置并启动新后台，新队列保持暂停。
“停止自有后台”会保留客户端状态窗口；可再次启动。查询连接状态不会自动重启服务。

--config 连接既有外部服务时，关闭窗口保持连接并留在托盘；显式退出仅断开连接，不改变它的派发状态。
如需停止外部服务，必须选择“停止外部服务…”并再次确认；此操作会影响它的其他连接。
服务实例身份或地址发生变化时，停止操作被拒绝，不会转而停止新出现的服务。

详细状态与保护见 [后台生命周期说明](DESKTOP-LIFECYCLE.md)。

默认数据结构：

```text
CodexQuotaScheduler/
  config/local.json         私人配置
  tasks.json                首次为空的任务导入清单
  desktop-state.json        通知偏好、检查点和脱敏记录（含有效备份）
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
npm.cmd run smoke:lifecycle
node --experimental-sqlite scripts/smoke-desktop.mjs --packaged .release/desktop/CodexQuotaScheduler-win32-x64/CodexQuotaScheduler.exe
node --experimental-sqlite scripts/smoke-lifecycle.mjs --packaged .release/desktop/CodexQuotaScheduler-win32-x64/CodexQuotaScheduler.exe
```

smoke 使用独立 `.local/desktop-acceptance-*`、模拟任务和临时回环调试端口，自动打开窗口并安全退出。
它清除子进程 PATH 中的 Node/npm，检查内置 SQLite、任务持久化、初始暂停、页面无 Node 权限、单实例与实例释放。
截图和不含控制密钥的结果摘要留在忽略目录。本机验证不等同于干净 Windows 虚拟机验收，也不替代真实任务验收。

smoke:lifecycle 仅使用本机协议替身和模拟配置，验证等待成功、取消确认、取消未确认待核对、退出不停止外部服务、确认停止外部服务、启动错误修正后显式重试，以及关闭到托盘后任务完成并准确定位，共七个场景。
不使用真实账户凭据或真实任务；结果与截图放在 `.local/lifecycle-acceptance-*`。具体本轮结果见生命周期说明。
