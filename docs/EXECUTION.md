# 手动任务执行

## 启动

完成 Codex 的 ChatGPT 订阅登录，并已有个人配置和任务后：

```powershell
npm.cmd run build
npm.cmd start -- config set provider codex
npm.cmd start -- task run review-project
npm.cmd start -- runs list review-project
```

默认使用 config/local.json，不存在时使用示例配置；建议先按 README 完成 config init 和 storage init。
任何命令均可通过 --config 指定独立配置。mock 或 :memory: 数据库不能放行真实执行。
命令保持前台运行，完成后在 stdout 输出完整 JSON 记录；在 stderr 输出 run_started 和 runId，以便在另一个终端查看/取消。
成功或确认取消退出码为 0，失败、待人工处理、等待额度为 1。

## 使用准备好的运行记录

```powershell
npm.cmd start -- runs prepare review-project
npm.cmd start -- runs start 运行ID
npm.cmd start -- runs show 运行ID
npm.cmd start -- runs events 运行ID
```

task run 原子创建记录并取得执行权。runs start 使用已有 queued/waiting_quota 记录，不重新读取提示词源文件。
已经启动或结束的记录不能再次提交。需要另一次独立执行时，显式调用 task run 创建新记录。
当前任务若已归档或停用，即使存在旧快照也不能启动它。

一份数据库内同时只允许一个执行者；并发调用会返回 EXECUTION_BUSY，不留下额外待执行记录。
独立数据库之间没有全局互斥，指向同一工作目录时应由使用者统一安排。

## 权限、模型和超时

任务对象可以添加：

```json
{
  "execution": {
    "sandbox": "read-only",
    "timeoutMs": 900000,
    "effort": "medium"
  }
}
```

这是任务定义的字段片段，修改后用 task update 和当前 revision 保存新版本。
支持只读 read-only 和工作区写入 workspace-write，默认只读；后者写入根为任务 projectDir，网络权限关闭。
不提供 danger-full-access 选项。沙箱策略是 Codex 执行策略，最终能力受本机系统与托管配置约束。
本模块将审批交给 user 路径，收到审批/输入请求时停止并标记待处理，不自动授权。

timeoutMs 默认 15 分钟，覆盖预检查与回合执行。停止通常会很快响应；等待启动 RPC 时，最多还需等待单次 RPC 的超时上限。
effort 可选 low/medium/high/xhigh，具体模型是否支持由 Codex 验证；model 仍使用任务已有的可选字段，不指定时继承 Codex 默认模型。
会话实际模型会记入 thread_ready 事件，不静默替换任务指定的模型。

## 会话续接

任务 session 为 {"mode":"new"} 时创建新会话，持久化 threadId 和 turnId。
续接使用 {"mode":"resume","threadId":"已有会话ID"}，要求位于相同 Codex home 中。
执行前先读取会话，验证项目目录和活动状态；目录不符或已有活动回合时，不发送任务。
这些检查无法对其他独立客户端提供跨客户端的原子互斥，续接时应避免在桌面端同时操作该会话。
不能假定任意桌面会话都能在另一个 Codex home 下访问。

## 额度与账户

执行前通过同一连接读取真实账户与完整额度，并在查询前后核对账户。ChatGPT 账户必须提供非空 email 或 workspaceId；无法验证身份时不发送任务。
手动执行与自动调度共用监控流中的持久化窗口历史，检查所有相关窗口以及 reservePercent；已知周窗口等后续缺失时仍视为未知。
额度未知、过期或达到保留阈值时保存 waiting_quota，并结束本次调用，不自动循环等待。
恢复后可手动再次 runs start；预检查没有提交指令，因此允许重试。
会话准备完成后再次读取账户并检查额度新鲜度、服务端窗口边界及当前监控状态。不满足放行条件时，最多重新完整查询一次；时钟回退直接等待。
写入提交标记和调用 turn/start 前还会同步检查一次，避免查询期间再次过期或被更新的观察取代。重查依旧不满足条件时保存 waiting_quota，不循环发送。
任务已经提交后不进行自动重试，避免重复操作。

## 取消和人工处理

```powershell
npm.cmd start -- runs cancel 运行ID
npm.cmd start -- runs show 运行ID
```

queued/waiting_quota 可直接取消。运行中的 cancel 命令保存取消请求，执行者在下次检查时调用 turn/interrupt；
返回 cancelRequested=true 不等于已经停止。只有收到回合 interrupted 终态才确认 cancelled。
Ctrl+C 和 SIGTERM 使用同一停止流程；超时确认中断后记录 failed，错误码为 EXECUTION_TIMEOUT。
如果停止通知未到、连接断开或提交确认丢失，记录 needs_attention，必须核对会话及文件变更。

审批、补充输入等也进入 needs_attention；本模块没有交互式审批界面。
取消不会撤销已经产生的文件变更。关闭父进程或等待本地进程退出也不等于回滚已执行的操作。

若进程突然退出，执行权可能保留。确认相关工作已经停止并核对会话后，可执行：

```powershell
npm.cmd start -- runs recover 运行ID
```

只有所属 PID 已不存在时才允许释放执行权，仍运行或无权判断时会拒绝。
遗留 running 状态改为 needs_attention；已经落盘的终态保持不变。该命令不查询或中断远程会话，也不重发任务。
PID 被操作系统复用时会保守地拒绝恢复；完整自动恢复属于后续阶段。

## 输出和事件

runs show 保存最终模型消息；执行中定期保存部分输出。agentMessage 完成项覆盖同项流式片段，避免重复文本。
较大的输出会请求停止并转人工处理。常见 Bearer / sk- 形状的认证信息会从保存的输出中遮蔽。
事件保存回合、条目类型、状态、命令退出码等元数据，不保存原始审批参数、原始协议错误或推理内容。
源码、凭据和验收数据不上传；数据库与输出仍属于本地个人数据。

## 实测与兼容性

2026-10-19 在 Windows、Codex CLI 0.163.0-alpha.10.2、Plus 账户上完成只读短指令验收：
收到预期固定文本，状态 succeeded，会话、回合、输出和事件均已持久化。
自动测试使用伪 CLI，覆盖成功、提前完成通知、失败、审批、额度阻塞、取消、超时、断线及重复提交。
数据库 schema 从 2 升级到 3，旧任务定义与 queued 记录保持兼容。

协议参考：[官方 App Server 文档](https://learn.chatgpt.com/docs/app-server)，并以本机生成的 Schema 核对枚举。
新版本 Codex 若调整协议，需重新核对；当前不启用实验性的 permission profile API。
