# Codex Quota Scheduler

本地运行的 Codex 额度监控与任务调度项目，面向 Windows，采用 TypeScript + Node.js。
目标：提前维护任务，在账户额度恢复且其他限制允许时，自动提交给 Codex。

**当前已完成真实额度读取、任务与配置持久化管理。默认演示使用模拟数据和内存存储；任务发送、持续监控和执行中的崩溃恢复尚未实现。**

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
| `pollIntervalMs` | 为持续监控预留的采样间隔，当前单次查询不使用它 |
| `quotaMaxAgeMs` | 调度预览允许的最大数据年龄 |
| `reservePercent` | 任一相关窗口剩余额度达到该阈值时，等待 |
| `limitId` | 当前任务使用的额度桶，默认 `codex` |
| `tasksFile` | 相对于配置文件位置的任务 JSON 路径 |
| `storage.databasePath` | 相对于配置文件位置的 SQLite 路径，默认 `../.runtime/state.sqlite` |
| `codex.executable` | Codex 命令名或可执行文件路径，默认 `codex` |
| `codex.args` | 可选启动器前置参数数组，默认 `[]` |
| `codex.home` | 可选 Codex 数据目录，仅设置在子进程环境中；默认继承现有配置 |
| `codex.requestTimeoutMs` | 版本检查和每个 RPC 的超时，默认 15000 毫秒 |
| `codex.shutdownTimeoutMs` | 关闭进程各阶段的等待时间，默认 1000 毫秒 |

批量导入示例位于 `examples/tasks.json`，提示词位于 `examples/prompts/`。
任务中的 `projectDir`、`promptFile` 相对于任务 JSON 文件位置解析。
`priority` 越大越优先，`enabled` 控制是否进入候选队列。模型可选，当前不硬编码模型名称。
`session` 支持描述新会话或指定 `threadId` 的续接意图；真实执行待开发。
个人任务与输出请放入 `.local/` 和 `.runtime/`，这两个目录均不提交。

## 模块

```text
src/
  domain/          额度、任务、执行记录及接口
  adapters/codex/  CLI 发现、stdio RPC、真实额度读取与响应归一化
  adapters/mock/   模拟额度适配器
  config/          配置加载、校验、原子保存和恢复
  tasks/           任务文件解析、导入和版本编辑服务
  monitor/         单次采样入口，预留持续监控
  scheduler/       纯函数调度条件判断
  executor/        真实执行器占位
  storage/         SQLite、版本迁移、任务/运行仓储和备份
  shared/          错误与校验工具
  app.ts           组合各模块
  cli.ts           命令行入口
tests/             额度、调度、配置与模拟流程测试
docs/              需求、架构和分阶段开发路线
```

框架没有生产环境运行时依赖，开发依赖通过 `package-lock.json` 固定。
持续集成会在 Windows 和 Linux 的 Node.js 22 环境运行类型检查、测试和模拟演示。

## 开发顺序

下一块是 **手动任务执行**，具体任务与验收见 [开发路线](docs/ROADMAP.md)。
整体职责与数据流见 [架构说明](docs/ARCHITECTURE.md)，产品边界见 [需求清单](docs/REQUIREMENTS.md)。

目前已持久化任务定义、指令版本和运行状态。自动调度上线前仍需实现执行权管理、重复提交防护及执行中的崩溃恢复。

## 接口依据

官方 [App Server 文档](https://learn.chatgpt.com/docs/app-server) 提供
`account/rateLimits/read` 和额度更新通知。窗口时长、已用比例和重置时间必须以返回数据为准。
官方 [非交互模式](https://learn.chatgpt.com/docs/non-interactive-mode) 可作为后续执行器的接入依据。

文档核对日期：2026-10-19。真实接入时需再次核对本机 Codex 版本与对应协议。

## 仓库

GitHub：<https://github.com/AiruoChen/codex-quota-scheduler>

本项目为个人工具框架，与 OpenAI 官方产品无隶属关系。
