# Codex Quota Scheduler 0.4.0

[查看目录](#contents) · [独立简明版](docs/QUICK-START.md) · [完整使用手册](docs/USER-MANUAL.md)

<a id="quick-start"></a>
## Codex 任务助手：用户使用手册（简明版）

适用：Windows 64 位客户端。按下面顺序操作即可。

<a id="quick-start-1"></a>
### 1. 下载并打开

1. 打开[项目下载页](https://github.com/AiruoChen/codex-quota-scheduler/releases)，在 **Assets（附件）** 中下载 Windows 客户端。
2. 下载的是安装包（`setup.exe`）：双击安装，再从桌面打开。
3. 下载的是便携 ZIP：右键选择“全部解压”，打开解压后的文件夹，双击 **`CodexQuotaScheduler.exe`**。保留整个文件夹。

**下载页没有附件时，请向项目提供者索取客户端包。** `Code → Download ZIP` 是源码，不能直接双击运行。

<a id="quick-start-2"></a>
### 2. 连接自己的 Codex 账户（首次使用）

1. 按[官方说明](https://learn.chatgpt.com/docs/codex/cli)安装 **Codex CLI**；已经安装的跳过此步。
2. 按 **Win + R**，输入 `powershell` 并回车。在打开的窗口输入 `codex login`，回车后按浏览器提示登录自己的 ChatGPT 账户。[官方登录说明](https://learn.chatgpt.com/docs/auth)
3. 打开本助手的“设置与帮助”：配置项选择 **`provider`**，值填写 **`codex`**，点击“保存配置”。
4. 点击顶部“后台服务 → 重启自有后台…”，按提示确认。
5. 回到“运行概览”，点击“查询额度”。看到自己的账户和真实额度后继续。

如果仍显示“模拟模式”，请先检查第 3、4 步；模拟模式不能执行真实任务。

<a id="contents"></a>
## 目录

- [简明上手（下载、打开与连接账户）](#quick-start)
  - [1. 下载并打开](#quick-start-1)
  - [2. 连接自己的 Codex 账户（首次使用）](#quick-start-2)
- [项目说明](#overview)
- [源码快速开始](#source-quick-start)
- [本地管理界面](#desktop)
- [验收与发布](#acceptance)
- [初始化本地管理数据](#initialize)
- [手动执行任务](#manual-execution)
- [持续额度监控](#monitoring)
- [自动调度](#scheduling)
- [异常与重启恢复](#recovery)
- [命令](#commands)
- [真实额度读取](#quota)
- [配置与任务](#configuration)
- [模块](#modules)
- [开发顺序](#roadmap)
- [接口依据](#protocol)
- [仓库](#repository)

<a id="overview"></a>
## 项目说明

本地运行的 Codex 额度监控与任务调度项目，面向 Windows，采用 TypeScript + Node.js。
目标：提前维护任务，在账户额度恢复且其他限制允许时，自动提交给 Codex。

需要排查问题时，再看[完整使用手册](docs/USER-MANUAL.md)或[离线 HTML 版](docs/USER-MANUAL.html)。当前代码版本统一为 **0.4.0**，发布状态为 Windows x64 测试客户端；安装包是否可下载，以 [Releases 附件](https://github.com/AiruoChen/codex-quota-scheduler/releases)为准。

**当前已完成真实额度读取、持久化管理、执行、持续监控、自动调度、异常/重启恢复，以及本地管理界面与运行包装。默认演示使用模拟数据和内存存储；自动队列初始暂停，须显式入队和启动。**

0.4.0 确定为当前已交付能力的版本，整合动态目录、明确授权续接、额度查询修复、队列移除和详细脱敏诊断。[版本说明](docs/RELEASE-NOTES-0.4.0.md)列出升级方法；[本次代码审计](docs/AUDIT-0.4.0.md)记录覆盖范围、发现及验证证据。

| 能力 | 0.4.0 的行为 |
| --- | --- |
| 新建任务 | 自动生成任务 ID，按 Codex 返回的模型和推理强度选择 |
| 项目与会话 | 按名称二级选择；兼容已验证的桌面旧关联，仍可查看全部会话 |
| 续接授权 | 自动展示实际目录，为本任务单独确认读取与写入范围，提交前核验 |
| 任务列表 | 默认新任务在前，可切换创建时间正序／倒序，保留偏好 |
| 额度设置 | 五小时／周保留线独立设置；窗口及刷新时间来自服务端 |
| 额度中断续接 | 默认关闭，满足准确失败、耗尽及重置证据后追加原始快照与指定后缀 |
| 队列清理 | 显式移除并保留历史；待核对记录确认后解除该项阻塞，派发仍暂停 |
| 错误排查 | 运行详情可查看、复制、下载详细脱敏诊断；缺少准确回合时禁用应用结果 |
| 定时计划 | 单次／每日启动、时区、有效期、错过处理和版本快照；保存草稿后需明确启用 |
| 窗口衔接 | 实验时间规划、服务端边界核对、额度保护和目标观测；不能保证改变重置时间 |

完整继承原会话权限、无文件夹官方项目、跨设备／远程环境仍有限制；真实恢复／发送及稳定版人工验收继续待补证据。原始需求的未完成项保留在[需求更新](docs/REQUIREMENTS-UPDATE-0.4.0.md)和[路线图](docs/ROADMAP.md)，不因版本号更新而标记完成。代码合并状态以当前 PR 为准，已安装客户端需要手动升级。

实现、兼容边界与验证步骤见 [本次需求实现说明](docs/IMPLEMENTATION-0.4.0.md)。目录浏览只查询元数据；自动续接只接受明确的 `usageLimitExceeded` 失败终态及完整真实耗尽窗口证据，等待服务端重置后在准确原会话追加原始快照与指定后缀。结果不明、其他错误或审批请求不会自动重发。

“继续已有会话”读取实际目录后，可在“为本次续接明确授权”中确认本机文件读取范围，并为写入模式勾选允许修改的文件夹（须含实际工作目录）。当前本机 CLI 无法限制读取目录，须明确确认可读取本机当前账户可读文件；网络固定关闭，额外审批不会自动同意。授权绑定任务版本及准确会话，保存不发送指令，执行前重查来源、目录、CLI 与管理策略，并核对恢复响应的实际权限；不一致则不发送指令。Codex 可能将所选权限保存为该会话后续默认设置。详见[续接明确授权](docs/RESUME-AUTHORIZATION.md)。

继续已有会话可先选项目，再按名称选择会话。针对桌面端“项目已迁移、会话归属尚未迁移”的情况，新增只读兼容层：从当前 Codex 数据目录读取明确的侧栏关联及新旧项目 ID 映射，并与当前账户接口返回的项目和会话交叉核对。下拉项标注“桌面项目关联”；不按目录猜测，不改写 Codex 状态或迁移标记。格式或来源不受支持时说明原因，仍可显式查看全部会话。兼容层使用经本机验证的桌面状态 v1 格式，属于本地兼容能力，非稳定公开 API；显示关联不继承文件权限。

<a id="source-quick-start"></a>
## 快速开始

续接权限核验提供固定检查项与详细脱敏请求时间线。`environments: null` 或结构已知的非空环境选择，只有从准确本机 CLI 生成的协议确认可显式禁用环境访问时才兼容，提交中固定发送空环境数组，目录、网络和审批仍逐项核验。队列支持显式移除待核对记录并保留历史；缺少准确回合时禁用应用远端结果。见[队列移除与详细诊断](docs/QUEUE-AND-DIAGNOSTICS.md)及[续接授权排查](docs/RESUME-AUTHORIZATION.md)。

额度查询已兼容同一刷新时间的 1 秒差异：完整、未过期的服务端读数不会再因此一直显示“未知”。仍保留较晚历史边界；1 秒内的时间变化不生成额度刷新事件，更大回退、缺失或过期仍按未知处理。更新后重启实际后台并查询额度即可，无需删除数据库或重新登录，见[额度查询修复说明](docs/QUOTA-QUERY-TROUBLESHOOTING.md)。

定时功能增加第七个页面“定时计划”：选择现有任务及版本 → 设置时间和时区 → 预览 → 保存草稿 → 明确启用 → 在调度队列启动进程并恢复派发。启用不会自动解除暂停。窗口衔接仅为实验估算，电脑及后台须保持运行；安装前备份并停止旧后台，新数据库模式为 11，不能让旧客户端继续写入。操作、架构和验收边界见[定时计划使用说明](docs/TIMED-PLANS.md)与[完整需求](docs/REQUIREMENTS-TIMED-START.md)。

`package.json` 与锁文件统一为 0.4.0，桌面、Codex 初始化信息、安装器及验收报告从版本清单取值；桌面入口为 `dist/src/desktop/bootstrap.js`。构建时选择包含所需功能的源码提交，合并后可使用 `main`。七页 GUI、后台生命周期、托盘通知、安装迁移和已有审计修复继续保留；稳定版门禁见下文。

需要 Node.js 22.12+ 和 npm。安装依赖后即可运行模拟演示，无需 Codex 登录或 API Key。

```powershell
npm.cmd ci
npm.cmd run check
npm.cmd test
npm.cmd run demo
```

Windows PowerShell 若限制执行 npm.ps1，请使用上面的 npm.cmd；其他终端可以直接使用 npm。

演示会输出 `source: "mock"`、`mode: "preview_only"` 和下一项任务的候选决策。
`action: "run"` 仅表示满足当前预览条件，不代表已发送指令。
`demo` 不修改个人数据库。Node.js 22.12 的 SQLite 实验参数已包含在 npm 启动和测试脚本中，
该版本可能输出 SQLite ExperimentalWarning，不影响 JSON 结果。

<a id="desktop"></a>
## 本地管理界面

已提供最小 Windows 桌面客户端：开发运行 `npm.cmd run desktop`，便携打包 `npm.cmd run package:desktop`。
便携目录自带运行时，双击 `CodexQuotaScheduler.exe` 即可运行；默认空任务模拟环境。
后台菜单提供状态、重启和停止；活动任务退出时可选择等待或请求取消，外部服务需要单独确认停止。
使用方法和当前边界见 [桌面客户端](docs/DESKTOP.md)，选型见 [技术决策](docs/DESKTOP-TECH-DECISION.md)。
本模块的状态、退出流程和验收见 [后台生命周期](docs/DESKTOP-LIFECYCLE.md)。
桌面回归会主动拦截重启后的页面加载并触发刷新，检查当前后台地址、窗口可见性和任务保留；CI 失败会提供脱敏诊断摘要。
托盘回归等待窗口实际显示/隐藏；原生关闭探针使用异步有界等待，失败报告区分超时、无窗口、窗口不唯一及系统拒绝，并标明准确的托盘子检查点。
已完成 GUI 基础框架与概览：六个导航入口、脱敏全局状态、全部额度窗口、当前运行和队列摘要；断线/过期显示未知。见 [GUI 使用与模块说明](docs/DESKTOP-GUI.md)。
任务管理已提供筛选分页、宽编辑区、桌面目录选择、版本冲突草稿保留及入队预览；队列展示快照顺序与后台等待原因。见 [任务与队列](docs/DESKTOP-TASKS-QUEUE.md)。
运行记录支持服务端筛选分页、输出/快照复制和保留阅读位置；异常页提供检查建议、准确回合核对及显式处理。见 [运行记录与异常处理](docs/DESKTOP-RUNS-RECOVERY.md)。
关闭窗口默认留在托盘，后台继续运行；托盘支持打开、状态、暂停派发和安全退出。通知提供脱敏文案、持久化去重、偏好和本地记录。见 [托盘与通知](docs/DESKTOP-TRAY-NOTIFICATIONS.md)。
已提供 Windows 当前用户安装包：`npm.cmd run package:installer`。数据管理支持一致性备份、旧数据导入为新副本、配置切换和升级准备；卸载保留用户数据。见 [安装与数据迁移](docs/DESKTOP-INSTALL-MIGRATION.md)。
客户端的设置页提供离线使用说明和脱敏诊断 JSON 导出；后台无法启动时，状态页仍可查看帮助。

<a id="acceptance"></a>
## 验收与发布

Windows x64 上可运行 `npm.cmd run acceptance -- --output-name candidate-001 --soak-seconds 60`，统一执行检查、测试、演示、便携与安装器打包、桌面/生命周期/安装迁移验收、隐私检查和协议替身稳定性烟测。干净源码提交通过后，输出 `.release/candidate-001/bundle/`，其中包含安装包、SHA256、版本说明及脱敏验收报告。`npm.cmd run verify:release -- --directory .release/candidate-001/bundle --channel candidate` 会重新核对文件和门禁；已用过的输出名不可覆盖。

CI 只对默认分支的成功 push 上传候选产物。受控的手动工作流可把核验后的产物发布为 GitHub 候选版。**稳定版仍要求真实账户、独立 Windows 环境、原生通知/缩放/故障人工验收、签名安装器及连续 24 小时实测；短时模拟报告不能替代这些证据。** 完整步骤、证据格式与失败处理见 [桌面客户端验收与发布](docs/DESKTOP-ACCEPTANCE-RELEASE.md)，本版变更见 [0.4.0 版本说明](docs/RELEASE-NOTES-0.4.0.md)。

```powershell
npm.cmd run ui
```

打开终端打印的地址，默认 `http://127.0.0.1:8765`。首次启动自动初始化被 Git 忽略的
`config/local.json`，默认使用模拟额度。也可以在构建后双击 `launch.cmd`；macOS/Linux 使用 `sh launch.sh`。

界面提供额度与刷新动态、任务编辑、版本快照、显式入队、手动执行、暂停/恢复调度、取消请求、
运行输出、异常核对、配置与轮转日志。服务启动只开启监控；使用真实配置时，先启动调度进程，再明确恢复队列。
关闭浏览器不会结束后台操作；配置保存后需重启服务。

```powershell
npm.cmd start -- service start
npm.cmd start -- service status
npm.cmd start -- service logs
npm.cmd start -- service stop
npm.cmd run package
```

后台服务通过已验证的本机实例停止，不按 PID 强杀进程。异常退出时使用 `service recover` 显式处理服务记录，
数据库执行权和结果仍按原恢复流程核对。便携目录生成在 `.release/codex-quota-scheduler/`，
复制整个目录即可运行，目标机器需要 Node.js 22.12+，无需 `npm install`。
运行方式、界面操作及边界见 [管理界面与运行包装](docs/MANAGEMENT.md)。

<a id="initialize"></a>
## 初始化本地管理数据

```powershell
npm.cmd run build
npm.cmd start -- config init
npm.cmd start -- storage init
npm.cmd start -- task list
```

默认创建被 Git 忽略的 `config/local.json`，数据库为 `.runtime/state.sqlite`。
首次任务访问会从 `tasksFile` 导入任务并保存提示词快照，之后以数据库为准；编辑源 JSON 不会自动覆盖已有任务。
任务编辑、版本检查、历史、备份和恢复见 [持久化管理说明](docs/PERSISTENCE.md)。

<a id="manual-execution"></a>
## 手动执行任务

已有个人配置和任务后，将 provider 设置为 codex，再执行指定任务：

```powershell
npm.cmd start -- config set provider codex
npm.cmd start -- task run review-project
npm.cmd start -- runs list review-project
```

执行使用数据库中的指令快照，检查真实额度与 ChatGPT 登录，默认只读权限。
命令等待完成后输出运行记录；启动时在 stderr 显示 runId。另一个终端可使用
`npm.cmd start -- runs cancel 运行ID` 请求取消。
已有 queued 记录可使用 `runs start 运行ID` 启动；`runs events 运行ID` 查看事件。
具体权限、超时、续接和异常处理见 [手动执行说明](docs/EXECUTION.md)。

RPC 拒绝现提供基于明确证据的固定类别及诊断编号，运行审计和脱敏诊断导出均不保留原始错误或私人正文。`diagnose:resume` 可对准确已记录运行进行只读来源、账户、目录与历史接口检查；读取通过不代表恢复或权限已经验证，不重试原任务。见 [RPC 诊断与续接兼容检查](docs/CODEX-RPC-DIAGNOSTICS.md)。

<a id="monitoring"></a>
## 持续额度监控

```powershell
npm.cmd start -- config set provider codex
npm.cmd start -- monitor watch
```

监控会轮询真实额度并处理更新通知，输出每次采样的 JSONL；Ctrl+C 停止。
`monitor status` 查看本地最新状态，`monitor events` 查看刷新、可用性和连接错误事件，均不访问网络。
`monitor sample` 查询一次并持久化；`monitor watch --samples 2` 可做有限采样。
重复快照不会重复生成刷新事件，重启后继续使用本地检查点；五小时窗口刷新也不能绕过周额度或保留阈值。
这些命令只监控，不提交任务。识别规则和错误处理见 [额度监控说明](docs/MONITORING.md)。

<a id="scheduling"></a>
## 自动调度

在已有个人任务和真实登录的基础上：

```powershell
npm.cmd start -- config set provider codex
npm.cmd start -- scheduler enqueue review-project
npm.cmd start -- scheduler resume
npm.cmd start -- scheduler start
```

默认在额度可用时按快照优先级串行执行；只运行显式入队的快照，不自动消费示例任务或 runs prepare 记录。
同一任务版本重复入队返回原运行记录；执行完不会循环重发。
`scheduler pause` 暂停领取下一项，`scheduler status` 查看队列和进程；Ctrl+C 停止前台调度并请求中断当前执行。
可用 `config set scheduler.trigger refresh` 切换为确认新刷新后触发一项任务，修改配置后重启进程生效。
审批、失败或结果不明会暂停队列；核对、恢复和触发模式详见 [自动调度说明](docs/SCHEDULING.md)。

<a id="recovery"></a>
## 异常与重启恢复

```powershell
npm.cmd start -- recovery status
npm.cmd start -- recovery repair
npm.cmd start -- recovery inspect 运行ID
npm.cmd start -- recovery reconcile 运行ID
```

启动调度前会检查遗留状态；异常时返回 RECOVERY_REQUIRED，不自动解锁或重新发送指令。
repair 只清理确认退出的进程权，并把结果不明记录转为待核对；不会宣称远端已停止。
inspect 只读原会话/回合；reconcile 在账户、目录和准确回合匹配时恢复已确认结果，队列保持暂停。
缺少来源或回合 ID 的旧记录继续人工核对，不猜测对应任务。使用流程和恢复日志见 [恢复说明](docs/RECOVERY.md)。

<a id="commands"></a>
## 命令

先运行 `npm.cmd run build`，然后使用：

```powershell
npm.cmd start -- help
npm.cmd start -- status
npm.cmd start -- tasks
npm.cmd start -- task list
npm.cmd start -- task history review-project
npm.cmd start -- runs list review-project
npm.cmd start -- config show
npm.cmd start -- preview
npm.cmd start -- status --config config/codex.example.json
npm.cmd start -- status --config config/local.json
```

默认优先加载 `config/local.json`，不存在时加载 `config/example.json`；可通过 `--config` 指定。
`demo` 默认使用示例配置并强制使用 mock 和内存库，确保演示可重复。
`provider: "mock"` 使用模拟数据；`provider: "codex"` 通过本机 Codex App Server 查询真实账户。

<a id="quota"></a>
## 真实额度读取

先确保安装了 Codex CLI，并使用 ChatGPT 订阅账户完成 `codex login`，然后执行：

```powershell
npm.cmd run build
npm.cmd start -- status --config config/codex.example.json
```

程序会检查 CLI 版本，完成初始化握手，读取账户状态和额度，然后关闭连接及子进程。
输出包含 `source: "codex"`、CLI 版本、账户邮箱/套餐，以及各额度窗口的剩余百分比和 UTC 重置时间。
未返回的窗口不会被补造。当前协议未提供工作区 ID 时，`account.workspaceId` 为 `null`。

复用 Codex 自己维护的登录凭据；本项目不读取或保存访问令牌，也不会启动任务或消费重置奖励。
详细连接配置、错误代码和实测记录见 [真实额度读取说明](docs/CODEX-QUOTA.md)。

<a id="configuration"></a>
## 配置与任务

| 配置 | 作用 |
| --- | --- |
| `provider` | `mock` 模拟数据；`codex` 真实账户查询 |
| `pollIntervalMs` | 持续监控的常规采样间隔，通知及预计重置边界可提前触发查询 |
| `quotaMaxAgeMs` | 监控状态、调度预览和执行检查允许的最大数据年龄 |
| `reservePercent` | 任一相关窗口剩余额度达到该阈值时，等待 |
| `limitId` | 当前任务使用的额度桶，默认 `codex` |
| `tasksFile` | 相对于配置文件位置的任务 JSON 路径 |
| `storage.databasePath` | 相对于配置文件位置的 SQLite 路径，默认 `../.runtime/state.sqlite` |
| `codex.executable` | Codex 命令名或可执行文件路径，默认 `codex` |
| `codex.args` | 可选启动器前置参数数组，默认 `[]` |
| `codex.home` | 可选 Codex 数据目录，仅设置在子进程环境中；默认继承现有配置 |
| `codex.requestTimeoutMs` | 版本检查和每个 RPC 的超时，默认 15000 毫秒 |
| `codex.shutdownTimeoutMs` | 关闭进程各阶段的等待时间，默认 1000 毫秒 |
| `scheduler.trigger` | `available`：额度可用即串行执行；`refresh`：确认新刷新后触发一项任务；默认 available |

批量导入示例位于 `examples/tasks.json`，提示词位于 `examples/prompts/`。
任务中的 `projectDir`、`promptFile` 相对于任务 JSON 文件位置解析。
`priority` 越大越优先，`enabled` 控制是否进入候选队列。模型可选，当前不硬编码模型名称。
`session` 支持新会话或指定 `threadId` 续接；续接前会检查项目和活动状态。
`execution` 可配置 read-only / workspace-write、timeoutMs 和 effort，缺省为只读、15 分钟超时。
个人任务与输出请放入 `.local/` 和 `.runtime/`，这两个目录均不提交。

<a id="modules"></a>
## 模块

```text
src/
  domain/          额度、任务、执行记录及接口
  adapters/codex/  CLI、stdio RPC、真实额度、执行回合和只读恢复协议
  adapters/mock/   模拟额度适配器
  adapters/http/   本机 HTTP 协议、会话与资源适配
  config/          配置加载、校验、原子保存和恢复
  tasks/           任务文件解析、导入和版本编辑服务
  monitor/         轮询、通知唤醒、退避与纯函数刷新识别
  scheduler/       纯条件判断和串行调度服务，仅依赖领域接口
  executor/        手动执行编排、执行权、取消与结果持久化
  recovery/        只读远端核对与本地恢复应用服务
  management/      管理应用服务、静态页面与后台操作管理
  runtime/         前后台生命周期、实例身份与轮转日志
  desktop/         Electron 窗口、独立用户数据、后台连接与安全退出
  storage/         SQLite、版本迁移、任务/运行仓储和备份
  shared/          错误与校验工具
  app.ts           组合各模块
  cli.ts           命令行入口
tests/             额度、调度、配置与模拟流程测试
docs/              需求、架构和分阶段开发路线
```

业务后端没有第三方 npm 运行依赖；桌面便携包包含 Electron 运行时，开发依赖通过 `package-lock.json` 固定。
持续集成会在 Windows 和 Linux 的 Node.js 22 环境运行类型检查、测试和模拟演示；Windows 作业另跑统一桌面验收。
`npm run check` 同时检查浏览器/工具 JavaScript 语法，以及领域层和调度器的依赖边界。
便携包按当前源码清单复制编译结果，排除遗留编译文件及输出目录中的额外文件。
代码审查范围、修复和验证边界见 [代码审查记录](docs/CODE-REVIEW.md)。

2026-10-26 的 [完整需求审计与修复跟进](docs/AUDIT-2026-10-26.md) 补齐了执行和版本兼容边界：手动与自动执行共用持久化额度窗口历史，缺失窗口或未知账户不能提交；会话准备后及实际发送前重验有效期，过期最多完整重查一次，仍未知则等待。导入配置在首次启动前也必须通过客户端版本标记检查。标准测试对每项用例设置 60 秒超时；桌面“安装与数据迁移”提供固定用户数据目录的打开入口。

<a id="roadmap"></a>
## 开发顺序

托盘、通知、安装包与数据迁移、设置帮助和候选版验收发布模块已实现；正式签名、独立机器和真实账户验收仍须按 [开发路线](docs/ROADMAP.md) 补足证据。
桌面客户端的页面设计、安装部署、数据迁移与分块验收草案见 [桌面客户端需求](docs/DESKTOP-CLIENT-REQUIREMENTS.md)；桌面外壳、便携目录、托盘、通知及安装迁移已实现，正式签名与干净系统验收待完成。
整体职责与数据流见 [架构说明](docs/ARCHITECTURE.md)，产品边界见 [需求清单](docs/REQUIREMENTS.md)。

异常检测、显式本地修复与准确回合结果核对已接通；证据不足的记录继续保留 needs_attention。
恢复不会自动重发或恢复派发；后台服务和管理界面已实现，服务重启后队列保持暂停。

<a id="protocol"></a>
## 接口依据

官方 [App Server 文档](https://learn.chatgpt.com/docs/app-server) 提供
`account/rateLimits/read` 和额度更新通知。窗口时长、已用比例和重置时间必须以返回数据为准。
官方 [非交互模式](https://learn.chatgpt.com/docs/non-interactive-mode) 可作为后续执行器的接入依据。

文档核对日期：2026-10-21。真实接入时需再次核对本机 Codex 版本与对应协议。

<a id="repository"></a>
## 仓库

GitHub：<https://github.com/AiruoChen/codex-quota-scheduler>

本项目为个人工具框架，与 OpenAI 官方产品无隶属关系。
