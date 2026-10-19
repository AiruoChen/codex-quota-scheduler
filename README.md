# Codex Quota Scheduler

本地运行的 Codex 额度监控与任务调度项目，面向 Windows，采用 TypeScript + Node.js。
目标：提前维护任务，在账户额度恢复且其他限制允许时，自动提交给 Codex。

**当前版本 0.1.0 是可运行的开发框架。额度为模拟数据，只做调度预览。真实账户读取、任务发送、持续监控和重启恢复尚未实现。**

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

## 命令

先运行 `npm.cmd run build`，然后使用：

```powershell
npm.cmd start -- help
npm.cmd start -- status
npm.cmd start -- tasks
npm.cmd start -- preview
npm.cmd start -- status --config config/local.json
```

默认加载 `config/example.json`。可以复制为被 Git 忽略的 `config/local.json` 后编辑。
`provider` 当前使用 `mock`；切换为 `codex` 会明确返回 `NOT_IMPLEMENTED`。

## 配置与任务

| 配置 | 作用 |
| --- | --- |
| `provider` | `mock` 模拟数据；`codex` 为下一阶段真实适配器 |
| `pollIntervalMs` | 为持续监控预留的采样间隔，当前单次查询不使用它 |
| `quotaMaxAgeMs` | 调度预览允许的最大数据年龄 |
| `reservePercent` | 任一相关窗口剩余额度达到该阈值时，等待 |
| `limitId` | 当前任务使用的额度桶，默认 `codex` |
| `tasksFile` | 相对于配置文件位置的任务 JSON 路径 |

任务示例位于 `examples/tasks.json`，提示词位于 `examples/prompts/`。
任务中的 `projectDir`、`promptFile` 相对于任务 JSON 文件位置解析。
`priority` 越大越优先，`enabled` 控制是否进入候选队列。模型可选，当前不硬编码模型名称。
`session` 支持描述新会话或指定 `threadId` 的续接意图；真实执行待开发。
个人任务与输出请放入 `.local/` 和 `.runtime/`，这两个目录均不提交。

## 模块

```text
src/
  domain/          额度、任务、执行记录及接口
  adapters/codex/  官方响应归一化、真实额度适配器占位
  adapters/mock/   模拟额度适配器
  config/          配置加载和校验
  tasks/           任务文件加载和校验
  monitor/         单次采样入口，预留持续监控
  scheduler/       纯函数调度条件判断
  executor/        真实执行器占位
  storage/         内存任务仓储，预留持久化
  shared/          错误与校验工具
  app.ts           组合各模块
  cli.ts           命令行入口
tests/             额度、调度、配置与模拟流程测试
docs/              需求、架构和分阶段开发路线
```

框架没有生产环境运行时依赖，开发依赖通过 `package-lock.json` 固定。
持续集成会在 Windows 和 Linux 的 Node.js 22 环境运行类型检查、测试和模拟演示。

## 开发顺序

下一块是 **真实 Codex 额度读取**，具体任务与验收见 [开发路线](docs/ROADMAP.md)。
整体职责与数据流见 [架构说明](docs/ARCHITECTURE.md)，产品边界见 [需求清单](docs/REQUIREMENTS.md)。

自动调度上线前必须完成持久化、重复提交防护、超时及崩溃恢复；目前的纯函数预览不承担这些职责。

## 接口依据

官方 [App Server 文档](https://learn.chatgpt.com/docs/app-server) 提供
`account/rateLimits/read` 和额度更新通知。窗口时长、已用比例和重置时间必须以返回数据为准。
官方 [非交互模式](https://learn.chatgpt.com/docs/non-interactive-mode) 可作为后续执行器的接入依据。

文档核对日期：2026-10-19。真实接入时需再次核对本机 Codex 版本与对应协议。

## 仓库

GitHub：<https://github.com/AiruoChen/codex-quota-scheduler>

本项目为个人工具框架，与 OpenAI 官方产品无隶属关系。
