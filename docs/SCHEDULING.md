# 自动调度

## 启动

已安装 Codex CLI、完成 ChatGPT 订阅登录并维护个人任务后：

```powershell
npm.cmd run build
npm.cmd start -- config set provider codex
npm.cmd start -- scheduler enqueue review-project
npm.cmd start -- scheduler resume
npm.cmd start -- scheduler start
```

队列初始暂停。enqueue 保存该任务当前版本的运行快照；resume 保存恢复状态；start 在前台运行监控和调度。
只运行显式入队的任务。普通 task list、preview、demo、monitor 和 runs prepare 均不会启用自动队列。
mock 来源或 :memory: 数据库不能启动真实调度。所有命令支持 --config；配置变更后重启进程生效。

start 持续运行，stdout 每行是一个 JSON 事件：scheduler_wait、scheduler_started 或 scheduler_finished。
等待原因包含 paused、busy、empty_queue、额度未知/耗尽、awaiting_refresh、refresh_consumed 等。
可使用 `scheduler start --samples 2` 限制采样次数；每次采样最多领取一项，空队列和失败采样也计数。
有限采样正常结束或 Ctrl+C 停止，进程退出码为 0；任务实际结果应查看 scheduler_finished、runs show 和暂停原因。
启动配置错误、存储失败、失去进程权等错误会停止并报错，不能用进程退出码替代每项任务状态。

## 队列与顺序

```powershell
npm.cmd start -- scheduler queue
npm.cmd start -- scheduler status
npm.cmd start -- scheduler remove 运行ID
npm.cmd start -- runs show 运行ID
npm.cmd start -- runs events 运行ID
```

- 同一任务 ID 和 revision 只入队一次；重复 enqueue 返回原记录，包括它已经完成或移除时。
- 运行快照、提示词和优先级入队后不变；修改任务后需显式 enqueue 新 revision，旧记录不会被覆盖。
- 多个版本可以各自入队；不再需要的旧记录应显式 remove。若需再次独立执行同一版本，可使用手动 task run。
- 候选记录限 queued / waiting_quota，按快照 priority 从高到低；相同优先级按入队顺序。
- 当前定义已停用或归档时跳过旧记录；恢复启用不会修改已保存指令。
- remove 只取消 queued / waiting_quota，不删除历史或去重键；已经运行的任务请用 runs cancel。
- 成功、失败、取消和 needs_attention 记录都不会再次自动提交。

一份数据库只允许一个调度进程，一次只执行一个任务，手动执行与自动调度共用 execution_lock。
独立数据库之间没有全局互斥，指向相同项目时应由使用者统一安排。

## 两种触发模式

默认 `scheduler.trigger=available`：每次取得新鲜真实快照，确认全部相关窗口可用后领取一项。
完成后重新采样，再考虑下一项；不会仅沿用上一个任务开始时的额度。

```powershell
npm.cmd start -- config set scheduler.trigger refresh
```

refresh 模式先等待确认新的周期刷新：

1. 首次启动从当前事件末尾建立游标，不追溯既有刷新或把初始 available 当成刷新。
2. 只接受配置 limitId 的新确认事件。多个窗口在一次观察中刷新，合并为一次单项触发；多次未处理观察也合并为最新触发。
3. 触发不足以绕过周额度、保留阈值或未知状态。额度仍阻塞时保留触发，之后新快照可用时再领取。
4. 领取时将触发与运行 ID 一起持久化。完成或提交失败后该触发不再启动另一项；下一项等待新刷新。
5. 执行器预检查保存 waiting_quota 且没有提交证据时，可重新检查并重试同一运行记录。

游标和触发在同一事务保存，重启不会通过重复事件盲目再发。同一模式/监控流首次启动只消费启动后的新事件；
后续启动可续用已保存的未消费触发。新增事件已过 quotaMaxAgeMs 时不追溯激活；历史明细被清理时不会推算遗漏刷新。
账户/套餐或时钟基线变化撤销旧触发，模式和额度策略变更使用独立消费上下文。
刷新证据遵循 MONITORING.md，提前人工重置或服务器缺少边界字段时可能保守地漏报。

## 暂停、停止和失败

```powershell
npm.cmd start -- scheduler pause
npm.cmd start -- scheduler resume
npm.cmd start -- runs cancel 运行ID
```

pause 立即持久化暂停领取，不中断已经取得执行权的任务；resume 的下一次动作仍需等到新采样，可能需一个 pollIntervalMs。
停止 start 进程（Ctrl+C / SIGTERM）会请求中断当前执行，并等待执行器确认结果；未收到终态仍是 needs_attention。
停止不回滚文件变更。普通停止空闲调度保留已有暂停/恢复状态，再次 start 使用该状态。

执行失败、取消、审批或 needs_attention 会自动暂停后续队列。
failed/cancelled 经检查后可以 resume，原记录仍不会重试；needs_attention 还需显式确认核对：

```powershell
npm.cmd start -- runs show 运行ID
npm.cmd start -- runs events 运行ID
# 核对 Codex 会话和文件变更，确认相关工作已经停止并决定后续安排后：
npm.cmd start -- scheduler acknowledge 运行ID
npm.cmd start -- scheduler resume
```

acknowledge 表示使用者已核对，允许调度其他排队记录；不改变 needs_attention 历史状态，
不宣称远端已取消，也不重发原任务。数据库内任何未确认的 needs_attention（含手动执行）都会阻止继续自动执行。
记录仍持有 execution_lock 时不能确认，必须先处理遗留任务执行权。
审批和补充输入不会自动同意，保持原有执行器策略。

## 崩溃与恢复

新版本启动调度前还会执行本地异常检查；发现遗留状态时返回 RECOVERY_REQUIRED。
推荐先使用 `recovery status` 查看，再用 `recovery repair` 显式修复本地进程权，
对结果不明记录调用 `recovery inspect / reconcile` 读取原回合证据。具体流程见 [异常恢复](RECOVERY.md)。

```powershell
npm.cmd start -- scheduler status
npm.cmd start -- scheduler recover
```

recover 只有在调度 PID 已不存在时才释放调度进程权，并把队列设为暂停。
PID 存在、被复用或无法判断时拒绝恢复；不会按本地超时抢占进程权。
它不释放任务 execution_lock，不查询远端、不取消会话、不重新提交任务。

若还有遗留执行权，核对工作已停止后使用 `runs recover 运行ID`，再按上面的 acknowledge / resume 流程处理。
已经领取而未完成的记录不会自动回到 queued，即使崩溃发生在实际发送前也需要人工核对。
领取、游标推进和触发绑定事务失败则整体回滚；提交开始后的错误一律沿用执行器的保守状态处理。

## 数据与验证

数据库 schema 5 引入自动队列表；当前 schema 6 还保存执行来源和恢复审计，旧任务、监控和运行记录保持兼容。
运行执行权增加 dispatch_started 一次使用标记，执行器从数据库重读快照并只接受一次执行入口。
启动前核对新鲜快照，执行器再读真实账户和额度，并核对其账户与调度采样一致；账户不一致时不发送指令。
模型、沙箱、目录和超时仍来自任务快照，默认只读，不硬编码模型或额度周期。
个人数据库、任务内容与验收文件只保留本地。此阶段不安装后台服务或开机启动项。

自动测试覆盖优先级/FIFO、暂停、版本去重、刷新合并、重启消费检查点、周额度阻塞、账户变化、
手动互斥、事务回滚、提交确认丢失、审批及跨进程 CLI。
2026-10-20 在 Windows / Codex CLI 0.163.0-alpha.10.2 / Plus 上完成 available 模式真实只读验收，
自动任务返回预期固定文本并保存会话、回合和成功状态；验收队列已暂停。
refresh 模式通过模拟时钟验证，真实验收未等待完整额度周期。
协议依据为 [官方 App Server 文档](https://learn.chatgpt.com/docs/app-server)，复用已验证的手动执行适配器。
