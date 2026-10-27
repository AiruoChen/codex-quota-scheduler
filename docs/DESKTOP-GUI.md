# GUI 基础框架与运行概览

日期：2026-10-25。适用：Windows 桌面客户端及同一后台提供的本机网页。

## 页面与操作

左侧导航提供运行概览、任务管理、调度队列、运行记录、异常与恢复、设置与帮助。
导航使用本地 hash，支持返回/前进、键盘焦点和直接进入页面；未知 hash 回到概览。
顶部持续显示模拟/真实来源、脱敏账户和本地服务连接状态，模拟环境另有常驻说明。

概览显示：

- 服务端实际返回的全部额度窗口、剩余比例、窗口时长及刷新时间，不假定只有五小时和周窗口。
- 服务端可用性判定与阻塞原因、最近查询和计划查询时间；曾存在但本次缺失的窗口保留为未知。
- 持有数据库执行权的当前运行，包含任务名称、版本、开始时间及进入详情的按钮，不在概览展示指令和输出。
- 待派发快照数量、调度暂停原因、需核对事项及最近监控事件。

“查询额度”请求完整查询。已有监控或调度循环时合并到原循环，保留最小间隔和错误退避，不创建第二个监控连接、不启停调度。
“开启监控/停止监控”只控制监控；调度正在负责监控时，需到调度队列管理该进程。
停止监控后读数到期显示未知，用户仍可手动查询；页面不会偷偷恢复持续监控。

“恢复派发”和“暂停派发”位于调度队列；“停止调度进程”有独立确认，避免与暂停混淆。
只有真实来源并启动调度后才能恢复派发；后台仍执行全部账户、额度、执行权、快照和恢复检查。

## 数据状态

加载中、空状态、未知、失败、离线均有文字提示。连接失败时隐藏实时额度数值，其余内容标为上次状态，并提供“重新连接”。
重新连接只重建 HTTP 会话和读取状态，不重启后台或重发任务。

窗口倒计时以服务端时间为锚，通过单调时钟推进，不依赖本机墙上时钟推算账户刷新。
读数有效期或服务端边界到达后，额度先变为未知；监控开启时仅请求一次完整查询。
计时、前端刷新、读取状态均不能生成刷新事件或自行认定额度恢复，事件与可用性仍以核心服务为准。

任务与队列已补齐编辑器、目录选择、筛选及预览，见 [任务与队列](DESKTOP-TASKS-QUEUE.md)。记录分页、输出复制与异常处理见 [运行记录与异常处理](DESKTOP-RUNS-RECOVERY.md)。配置和诊断向导继续分块实施。
关闭窗口默认隐藏到托盘，显式退出沿用后台生命周期流程；[托盘与通知](DESKTOP-TRAY-NOTIFICATIONS.md)已实现，安装迁移尚待开发。

## 模块边界

| 模块 | 职责 |
| --- | --- |
| management/gui/app.ts | 页面协调、轮询与固定操作绑定 |
| management/gui/api.ts | 同源请求、会话 CSRF、超时与错误 |
| management/gui/state.ts | 合并并发状态请求、服务端时间锚、到期失效、离线保留历史 |
| management/gui/shell.ts、dom.ts、labels.ts | 导航、全局状态、安全文本组件及统一状态文案 |
| management/gui/overview.ts | 额度、当前运行、摘要和动态的呈现 |
| management/gui/tasks.ts、queue.ts、runs.ts、recovery.ts、settings.ts | 独立页面模块，复用原业务操作 |
| management/quota-display.ts | 服务端展示模型和脱敏；不改变调度可用性判断 |
| management/contracts.ts | 类型专用 HTTP 契约；编译后不向页面导入后台实现 |
| management/gui-assets.ts | HTTP 可提供的浏览器模块白名单 |

新增前端代码纳入 TypeScript 严格检查，不增加前端框架或运行依赖。
检查脚本禁止浏览器运行时导入 GUI 以外模块。HTTP 只提供明确白名单，不暴露服务、数据库实现或源码映射。
DOM 使用文本节点显示任务名称、指令、输出与协议消息；管理页面没有 Node 权限，仅通过隔离 preload 提供固定目录选择方法。
所有写操作继续走回环 HTTP 会话与 CSRF 校验，停止服务仍等待后台结果落盘。

## 验证

```powershell
npm.cmd run check
npm.cmd test
npm.cmd run demo
npm.cmd run smoke:desktop
npm.cmd run package:desktop -- --output-name desktop-gui
node --experimental-sqlite scripts/smoke-desktop.mjs --packaged .release/desktop-gui/CodexQuotaScheduler-win32-x64/CodexQuotaScheduler.exe
node --experimental-sqlite scripts/smoke-lifecycle.mjs --packaged .release/desktop-gui/CodexQuotaScheduler-win32-x64/CodexQuotaScheduler.exe
```

GUI smoke 实际操作六个入口、新建/编辑任务第二版、入队快照和详情，检查模拟派发禁用、HTML 文本转义、监控停止/查询/开启、离线未知与重连。
布局覆盖 1200×800、960×640（1.5/2 倍设备比例）和 390×844；截图及摘要仅存于忽略的 `.local`。
这不替代系统显示设置下的完整人工缩放验收、干净机器安装、24 小时稳定性或真实账户执行验收。

本轮本机结果：严格检查、209 项回归和模拟演示通过；开发版与打包版 GUI smoke 通过，打包版六个生命周期场景通过，0 页面脚本异常。没有提交真实账户任务。
