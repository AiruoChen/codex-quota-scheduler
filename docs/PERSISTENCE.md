# 任务与配置持久化管理

## 开始使用

```powershell
npm.cmd run build
npm.cmd start -- config init
npm.cmd start -- storage init
npm.cmd start -- task list
```

config init 从示例配置创建个人 config/local.json，不覆盖已有文件。默认命令优先使用这个个人配置，
可在任意命令后加 --config 路径指定其他配置。若希望从真实额度配置开始，使用
`npm.cmd start -- config init config/codex.example.json`。

数据库路径由 storage.databasePath 决定，默认 .runtime/state.sqlite。第一次任务访问导入 tasksFile 中的任务和
当时的指令内容，并写入持久化导入标记。以后的重启不会再读种子文件，也不会复活已删除任务。
旧 schemaVersion=1 配置不需修改，缺少 storage 配置时使用兼容默认值。

Node 22.12 使用内置 SQLite 需要 --experimental-sqlite，npm start、npm test、npm run demo 已包含。
直接使用 node 调用任务相关命令时也要加该参数。SQLite 实验提示输出到 stderr，不混入 stdout 的 JSON 结果。
demo 始终使用 mock 和内存库，不修改个人数据库。

## 新增与修改任务

task add 接收一个任务对象，task import 接收任务数组。示例：将以下内容保存为 .local/my-task.json。

```json
{
  "id": "my-task",
  "name": "检查项目",
  "enabled": true,
  "projectDir": "..",
  "promptFile": "../examples/prompts/review-project.md",
  "priority": 20,
  "session": { "mode": "new" }
}
```

```powershell
npm.cmd start -- task add .local/my-task.json
npm.cmd start -- task show my-task
npm.cmd start -- task update .local/my-task.json --revision 1
npm.cmd start -- task disable my-task --revision 2
npm.cmd start -- task enable my-task --revision 3
npm.cmd start -- task history my-task
npm.cmd start -- task delete my-task --revision 4
```

新增后的 revision=1，每次编辑或启停加一。请以 task show 返回的当前 revision 为准。
旧 revision 返回 TASK_CONFLICT，不会覆盖其他进程的修改。
update 接收完整定义，并重新读取 promptFile；单独修改 JSON/Markdown 源文件不会改变数据库中的版本。
enable/disable 复用已保存的指令快照，即使源提示词文件已不存在也可操作。

projectDir 和 promptFile 相对于任务 JSON 文件解析；数据库中保存绝对路径。
同一 ID 不允许重复新增，归档后也不复用。delete 是归档，任务不再进入候选列表，版本和运行记录保留。
批量 import 遇到任一重复 ID 时整体回滚，不进行静默合并；需要修改已有任务时使用 update。
首次显式 import 成功会完成导入标记，因此可先导入自己的数组，避免自动导入示例。

## 指令版本与运行记录

```powershell
npm.cmd start -- task history review-project
npm.cmd start -- runs prepare review-project
npm.cmd start -- runs list review-project
```

runs prepare 保存一个状态为 queued 的运行记录，不启动 Codex，也不查询额度。
返回运行 ID 后可以使用 `npm.cmd start -- runs show 运行ID` 查询。
记录保存当时的任务版本、完整定义、指令内容、SHA-256 和创建时间；startedAt、completedAt 初始为 null。
之后修改或归档任务，不会改变这个快照。

执行器将来通过 RunRepository 更新状态、输出和时间，不能改写指令或任务快照。
终态记录不能重新变为 running；手动执行见 [执行说明](EXECUTION.md)。程序不会自动启动 queued 记录或重发结果不明的任务。

## 配置管理

```powershell
npm.cmd start -- config show
npm.cmd start -- config set reservePercent 20
npm.cmd start -- config set pollIntervalMs 30000
npm.cmd start -- config set provider codex
npm.cmd start -- config restore
```

数字、数组等使用 JSON 值；字符串配置也接受普通文本或路径，含空格的值按终端规则引用。
允许修改的键包括 provider、pollIntervalMs、quotaMaxAgeMs、reservePercent、limitId、tasksFile、codex 的连接设置、
storage.databasePath。未知键与非法值不会写入文件。

保存时保留原配置中的相对路径，写锁期间先校验，再保存上一个有效配置到 .bak，最后原子替换目标 JSON。
config init 复制时会固定从源文件解析出的路径，避免目标目录变化导致路径含义改变。
config restore 校验并恢复 .bak，即使当前 JSON 已损坏也能使用，不会用坏文件覆盖有效备份。

遇到 CONFIG_BUSY 时，另一进程可能正在写入。若确认先前写入进程已经崩溃，可以读取配置旁的 .lock 文件查看 pid，
确认该进程不再运行后清理这个单独锁文件，再重试。程序不自动抢占遗留锁，避免误删活动写入者的锁。
配置保存和 SQLite 更新是独立事务；修改数据库路径不会自动搬运旧库。

## 检查、备份与恢复

```powershell
npm.cmd start -- storage check
npm.cmd start -- storage backup .local/backup-01.sqlite
```

storage check 检查 SQLite 结构/关联、指令校验和及记录格式。数据库损坏会明确报错，原文件保留，不会自动创建空库替代。
备份通过 SQLite VACUUM INTO 生成一致的独立数据库文件，不直接复制可能含未合并 WAL 的活动数据库。
目标应是新的文件名；有效的已有备份不会被覆盖。中断的备份可能不完整，切换前需要验证。

从备份恢复的推荐方式是保留原库，先在独立配置中指向备份并执行 storage check，确认后再切换个人配置：

```powershell
npm.cmd start -- config set storage.databasePath ../.local/backup-01.sqlite
npm.cmd start -- storage check
npm.cmd start -- task list
```

上面路径相对于 config/local.json。切换后，备份文件成为新的活动数据库；如需保留只读的原始备份，先复制备份为另一个工作副本。
不要删除正在使用的 SQLite -wal 或 -shm 文件。跨机器迁移后，任务中保存的项目/提示词绝对路径需要按目标机器更新。

## 模块与边界

- storage/database.ts：连接、同步事务、迁移、完整性检查与备份。
- storage/task-repository.ts：定义、revision、历史与归档。
- storage/run-repository.ts：不可变运行快照与状态转换。
- tasks/service.ts：文件导入、指令读取及任务编辑。
- config/manage.ts：配置写锁、有效备份与原子保存。

当前数据库 schema=6，新增执行来源和恢复审计表；旧任务、监控、队列与执行记录保持兼容。
不会替旧记录补造来源或回合 ID。运行异常后的修复和只读结果核对见 [恢复说明](RECOVERY.md)。
升级按顺序在事务中执行；较新的 schema 会被拒绝，不能使用旧程序覆盖它。
SQLite、个人配置、备份及真实任务均应保存在 .runtime/ 或 .local/，不提交到 GitHub。
prepared 记录可以通过 runs start 显式启动；只有 scheduler enqueue 创建的记录进入自动队列。

实现依据：[Node.js 22.12 SQLite 文档](https://nodejs.org/download/release/v22.12.0/docs/api/sqlite.html)、
[SQLite 事务](https://www.sqlite.org/lang_transaction.html)、[SQLite VACUUM INTO](https://www.sqlite.org/lang_vacuum.html)。
