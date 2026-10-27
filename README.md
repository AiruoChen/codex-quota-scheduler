# Codex Quota Scheduler

本地运行的 Codex 额度监控与任务调度项目，面向 Windows，采用 TypeScript + Node.js。
目标：提前维护任务，在账户额度恢复且其他限制允许时，自动提交给 Codex。

**当前已完成真实额度读取、持久化管理、执行、持续监控、自动调度、异常/重启恢复，以及本地管理界面与运行包装。默认演示使用模拟数据和内存存储；自动队列初始暂停，须显式入队和启动。**

## 快速开始

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

## 本地管理界面

已提供最小 Windows 桌面客户端：开发运行 `npm.cmd run desktop`，便携打包 `npm.cmd run package:desktop`。
便携目录自带运行时，双击 `CodexQuotaScheduler.exe` 即可运行；默认空任务模拟环境。
后台菜单提供状态、重启和停止；活动任务退出时可选择等待或请求取消，外部服务需要单独确认停止。
使用方法和当前边界见 [桌面客户端](docs/DESKTOP.md)，选型见 [技术决策](docs/DESKTOP-TECH-DECISION.md)。
本模块的状态、退出流程和验收见 [后台生命周期](docs/DESKTOP-LIFECYCLE.md)。
桌面回归会主动拦截重启后的页面加载并触发刷新，检查当前后台地址、窗口可见性和任务保留；CI 失败会提供脱敏诊断摘要。
已完成 GUI 基础框架与概览：六个导航入口、脱敏全局状态、全部额度窗口、当前运行和队列摘要；断线/过期显示未知。见 [GUI 使用与模块说明](docs/DESKTOP-GUI.md)。
任务管理已提供筛选分页、宽编辑区、桌面目录选择、版本冲突草稿保留及入队预览；队列展示快照顺序与后台等待原因。见 [任务与队列](docs/DESKTOP-TASKS-QUEUE.md)。
运行记录支持服务端筛选分页、输出/快照复制和保留阅读位置；异常页提供检查建议、准确回合核对及显式处理。见 [运行记录与异常处理](docs/DESKTOP-RUNS-RECOVERY.md)。
关闭窗口默认留在托盘，后台继续运行；托盘支持打开、状态、暂停派发和安全退出。通知提供脱敏文案、持久化去重、偏好和本地记录。见 [托盘与通知](docs/DESKTOP-TRAY-NOTIFICATIONS.md)。
已提供 Windows 当前用户安装包：`npm.cmd run package:installer`。数据管理支持一致性备份、旧数据导入为新副本、配置切换和升级准备；卸载保留用户数据。见 [安装与数据迁移](docs/DESKTOP-INSTALL-MIGRATION.md)。
客户端的设置页提供离线使用说明和脱敏诊断 JSON 导出；后台无法启动时，状态页仍可查看帮助。

## 验收与发布

Windows x64 上可运行 `npm.cmd run acceptance -- --output-name candidate-001 --soak-seconds 60`，统一执行检查、测试、演示、便携与安装器打包、桌面/生命周期/安装迁移验收、隐私检查和协议替身稳定性烟测。干净源码提交通过后，输出 `.release/candidate-001/bundle/`，其中包含安装包、SHA256、版本说明及脱敏验收报告。`npm.cmd run verify:release -- --directory .release/candidate-001/bundle --channel candidate` 会重新核对文件和门禁；已用过的输出名不可覆盖。

CI 只对默认分支的成功 push 上传候选产物。受控的手动工作流可把核验后的产物发布为 GitHub 候选版。**稳定版仍要求真实账户、独立 Windows 环境、原生通知/缩放/故障人工验收、签名安装器及连续 24 小时实测；短时模拟报告不能替代这些证据。** 完整步骤、证据格式与失败处理见 [桌面客户端验收与发布](docs/DESKTOP-ACCEPTANCE-RELEASE.md)，本版变更见 [0.3.0 版本说明](docs/RELEASE-NOTES-0.3.0.md)。

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

## 开发顺序

托盘、通知、安装包与数据迁移、设置帮助和候选版验收发布模块已实现；正式签名、独立机器和真实账户验收仍须按 [开发路线](docs/ROADMAP.md) 补足证据。
桌面客户端的页面设计、安装部署、数据迁移与分块验收草案见 [桌面客户端需求](docs/DESKTOP-CLIENT-REQUIREMENTS.md)；桌面外壳、便携目录、托盘、通知及安装迁移已实现，正式签名与干净系统验收待完成。
整体职责与数据流见 [架构说明](docs/ARCHITECTURE.md)，产品边界见 [需求清单](docs/REQUIREMENTS.md)。

异常检测、显式本地修复与准确回合结果核对已接通；证据不足的记录继续保留 needs_attention。
恢复不会自动重发或恢复派发；后台服务和管理界面已实现，服务重启后队列保持暂停。

## 接口依据

官方 [App Server 文档](https://learn.chatgpt.com/docs/app-server) 提供
`account/rateLimits/read` 和额度更新通知。窗口时长、已用比例和重置时间必须以返回数据为准。
官方 [非交互模式](https://learn.chatgpt.com/docs/non-interactive-mode) 可作为后续执行器的接入依据。

文档核对日期：2026-10-21。真实接入时需再次核对本机 Codex 版本与对应协议。

## 仓库

GitHub：<https://github.com/AiruoChen/codex-quota-scheduler>

本项目为个人工具框架，与 OpenAI 官方产品无隶属关系。
