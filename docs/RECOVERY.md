# 异常与重启恢复

## 基本流程

```powershell
npm.cmd run build
npm.cmd start -- recovery status
npm.cmd start -- recovery repair
npm.cmd start -- recovery inspect 运行ID
npm.cmd start -- recovery reconcile 运行ID
npm.cmd start -- recovery events 运行ID
```

所有命令支持 --config。status、repair、events 只访问本地数据库；inspect、reconcile 需要 provider=codex 和文件数据库。
先完成数据库迁移与完整性校验，数据异常会明确失败，不重建空库或覆盖原文件。

| 命令 | 作用 |
| --- | --- |
| status | 报告进程状态、遗留执行权、无锁 running、提交证据冲突和未确认 needs_attention |
| repair | 显式修复本地遗留状态，在事务中重新检查进程；不会查询或停止远端 |
| inspect ID | 只读原会话/回合证据，不修改运行状态或写恢复审计 |
| reconcile ID | 为 needs_attention 应用已验证的远端结果，并记录恢复审计 |
| events [ID] | 查询最近 1000 条全局或指定运行的恢复审计，不删除较旧记录 |

调度启动时在事务内检查遗留状态；发现异常会返回 RECOVERY_REQUIRED，查询额度或派发之前停止。
手动新执行也拒绝绕过无锁 running、遗留任务权和不一致提交记录。
普通任务失败仍沿用既有暂停流程；完整后台进程守护和开机启动不属于本模块。

## 本地修复规则

- PID 仅在操作系统明确报告进程不存在时视为 dead。仍存活、PID 被复用、无权限或无法判断均不抢占。
- 确认退出的调度进程权可清理，并使队列暂停。
- 确认退出的任务执行权可清理；对应 running 记录转为 needs_attention。
- 运行状态已是 succeeded/failed/cancelled 时只清理遗留锁，不回退已保存终态。
- 没有对应执行权的 running，或 queued/waiting_quota 却存在 turnId/提交开始证据，转为 needs_attention。
- 正常 queued/waiting_quota 保持不变；已领取记录不自动重新入队，即使它可能尚未发送。

repair 在一笔事务中保存状态、执行权清理、暂停和审计；保存失败整体回滚。
重复调用不会重复清理同一执行权或重新生成相同状态转换；尚未解决的问题仍会出现在报告中。
status 是当前观察结果，实际修复会在事务中重读状态，不能把之前的报告当作清理许可。
释放本地 PID 锁不代表远端已经结束，不能仅因此宣称任务已取消。
旧的 scheduler recover 和 runs recover 仍可分别处理遗留进程权，并会写入恢复审计和保持暂停。

## 远端结果核对

新真实执行会在提交之前保存：连接配置摘要、账户邮箱/工作区/套餐和 CLI 版本；路径不写入审计事件。
恢复要求连接位置匹配，且查询前后账户与保存的账户一致；CLI 版本用于诊断，不锁死为同一版本。
然后读取原 threadId，确认返回 ID 和项目目录，再按准确 turnId 查找历史。

读取调用限 initialize、account/read、thread/read、thread/turns/list、thread/items/list 等只读协议方法。
不调用 thread/resume、turn/start、turn/steer 或 turn/interrupt，不触发推理、自动审批或补充输入。
历史优先分页读取回合元数据，再只读取目标回合消息，避免加载整个会话的工具输出。
回合和消息各最多 20 页，每页 50 项，恢复消息文本上限 1 MiB；达到上限、分页循环或数据异常时继续待核对。
旧版不支持回合分页时可回退到兼容的 thread/read includeTurns=true；仍须准确找到目标回合和完整消息视图。

| 证据 | 应用结果 |
| --- | --- |
| 准确回合 completed | succeeded，恢复模型文本 |
| 准确回合 failed | failed，使用稳定错误说明，不保存原始协议错误 |
| 准确回合 interrupted | cancelled；若本地有超时中断记录则保留 failed / EXECUTION_TIMEOUT 语义 |
| 会话或回合仍活动 | pending，保持 needs_attention |
| 找不到回合、来源/账户/目录不匹配、读取失败或数据不完整 | unknown，保持 needs_attention |

最终输出优先使用 final_answer 消息，同项消息按 ID 去重，不保存推理或原始工具命令。
历史没有可用消息时保留原部分输出，并在执行事件 recovery_confirmed 中标记 existing_partial；不会声称它是恢复的最终文本。
常见 Bearer 和 sk- 形状凭据会遮蔽；个人结果仍应作为本地私密数据管理。

reconcile 仅更新 needs_attention，要求该记录已没有执行权。网络查询前先暂停队列并撤销旧确认，取消查询也保持暂停。
核对期间运行记录或来源被修改时返回 RECOVERY_CONFLICT，不覆盖新数据。
结果、暂停状态和审计一起提交；未知或仍活动时保留原状态、部分输出和指令快照。
新的核对会撤销旧的人工确认；不能依靠早先的 acknowledge 绕过刚发现的活动回合。
inspect 可以查看其他本地状态的记录，但它始终不修改运行结果。

## 缺失证据与恢复派发

旧版本没有保存执行来源时，返回 ORIGIN_UNKNOWN，不替旧记录补造账户/连接来源。
turn/start 确认丢失而没有 turnId 时，返回 TURN_ID_UNKNOWN；不会用“最近回合”、相似指令或本地时间猜测对应关系。
服务端历史不存在、已删除或超出读取上限时也不推断任务从未运行，不能据此自动重发。

核对成功或失败后队列都保持暂停。检查输出和文件变更、处理全部未解决项后，再显式：

```powershell
npm.cmd start -- scheduler resume
npm.cmd start -- scheduler start
```

证据不足时可继续人工核对 Codex 会话和项目；确认工作已经停止并决定后续安排后，沿用 scheduler acknowledge ID / resume 流程。
acknowledge 不改变历史结果、不声称远端已取消，也不重新提交旧记录。
一旦确认终态，该记录保持终态，不会因为重新启动调度而再次派发。
恢复不是回滚，不撤销已经完成的文件操作。

## 持久化与限制

schema 6 新增 execution_origins 与 recovery_events，旧任务快照、监控、队列和触发消费检查点保留。
保存来源发生在指令提交之前；提交以后不能改写来源。审核日志只保存必要代码和状态元数据，不保存账户凭据、原始 RPC 错误或推理。
PID 状态是本地检测，不证明远端状态；不能可靠区分已被系统复用的 PID，因此保守拒绝抢占。
不同客户端间不存在跨客户端原子账户快照；两次账户查询之间极短暂的切换再切回仍无法完全识别。
数据库损坏的恢复继续使用 PERSISTENCE.md 的备份检查和切换流程，本模块不自动选择备份或合并坏数据。

## 验证

自动测试覆盖分页、旧版回退、准确回合筛选、账户/目录变化、回合仍活动、缺失来源/回合 ID、
超时和取消、并发修改、事务回滚、存活/未知 PID、重复修复、原终态保留和跨进程 CLI。
2026-10-21 在 Windows / Codex CLI 0.163.0-alpha.10.2 / Plus 账户完成真实验收：
独立只读短指令先成功执行，再模拟本地最终结果丢失，通过只读分页找回原回合的预期文本和成功状态。
恢复阶段只读历史，没有重发指令、启动新回合或自动恢复队列；验收数据仅存于 .local。
协议依据为 [官方 App Server 文档](https://learn.chatgpt.com/docs/app-server) 及本机生成的 Schema。
