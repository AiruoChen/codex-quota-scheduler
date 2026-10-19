# 真实 Codex 额度读取

## 使用

需要 Node.js 22.12+、已安装的 Codex CLI，以及通过 ChatGPT 订阅登录的账户。
查询不会发起模型任务，也不主动兑换额度重置奖励。

```powershell
codex --version
codex login
npm.cmd run build
npm.cmd start -- status --config config/codex.example.json
```

如果已经登录，不需要重复运行 codex login。
`status` 返回 JSON。实际账户邮箱仅在本地命令输出中显示；不要将完整真实输出提交到仓库。
`resetsAt` 使用 UTC ISO 8601 格式；`fetchedAt` 是接收到额度结果的时间。
工作区 ID 并非当前账户接口必有字段，未返回时保留 `null`。

## 连接配置

复制 config/codex.example.json 为被 Git 忽略的 config/local.json，再根据需要添加：

```json
{
  "codex": {
    "executable": "codex",
    "args": [],
    "home": "../.local/codex-home",
    "requestTimeoutMs": 15000,
    "shutdownTimeoutMs": 1000
  }
}
```

上面是需要合入完整配置的字段片段。通常不需要设置 home，默认继承运行环境中的 CODEX_HOME，
未设置时由 Codex 使用自己的默认目录。自定义目录需要预先在该目录完成 Codex 登录。
示例 home 位于本项目 .local 中，不是现有桌面登录目录。

executable 含路径分隔符时相对于配置文件解析；仅命令名则在 PATH 中查找。
home 同样相对于配置文件解析。args 是启动器的前置参数，逐个传递，路径使用参数原值，
相对参数路径以运行命令时的工作目录为准。不要向参数中填写令牌。

Windows 原生 codex.exe 可直接使用。标准 npm 安装的 codex.cmd / codex.ps1 会解析到相邻
node_modules/@openai/codex/bin/codex.js，并通过当前 Node.js 启动，避免依赖 shell 转义。
自定义 shell 启动脚本不自动执行，应指定原生文件或明确的 Node.js 入口。
子进程均隐藏窗口，保持现有终端的正常交互。

## 生命周期

1. 查找 CLI，执行 --version 验证启动器。
2. 启动 codex app-server --listen stdio://。
3. 完成 initialize / initialized 握手。
4. 用 account/read 检查 ChatGPT 登录，refreshToken=false。
5. 调用 account/rateLimits/read，转换为 QuotaSnapshot。
6. 关闭 stdin 等待退出；超出关闭等待时间则终止子进程。

该模块不自行刷新令牌，凭据生命周期由 Codex 管理。
版本号仅用于诊断，实际兼容性由握手和必需方法响应验证，不以随意设定的最低版本替代协议检查。
分帧支持跨数据块 UTF-8；单条消息限制为 1 MiB。通知不会被误认为请求结果。
服务端反向请求返回 Method not found，不承接登录、令牌刷新或操作审批。
RPC 原始错误和 stderr 不写入应用日志，避免凭据或调试信息泄漏。

## 常见错误

| 错误码 | 处理方式 |
| --- | --- |
| CODEX_NOT_FOUND | 安装 CLI、修正 PATH，或指定 codex.executable |
| CODEX_LAUNCHER_UNSUPPORTED | 改用原生可执行文件或标准 npm 启动入口 |
| CODEX_START_FAILED | 检查可执行文件、运行权限和前置参数 |
| CODEX_INCOMPATIBLE | 核对 CLI 版本与 App Server 协议，必要时更新 CLI |
| CODEX_AUTH_REQUIRED | 在相同 Codex home 下完成 codex login |
| CODEX_AUTH_UNSUPPORTED | 使用 ChatGPT 订阅登录，API Key/其他提供方不适用于本模块 |
| CODEX_TIMEOUT | 检查网络与登录，必要时增大 requestTimeoutMs |
| CODEX_NETWORK_ERROR | 检查网络、代理或稍后重试 |
| CODEX_EXITED / CODEX_CONNECTION_CLOSED | 检查 Codex 配置及子进程能否正常运行 |
| CODEX_PROTOCOL_ERROR | 核对协议；缺失或异常数据不能当作额度已恢复 |
| CODEX_RPC_ERROR | Codex 拒绝请求，需结合 CLI 自身状态排查 |

在受限环境里，Codex 需要正常的账户存储访问和网络权限；项目运行权限必须允许其正常启动。

## 验证记录

2026-10-19 在 Windows、Codex CLI 0.163.0-alpha.10.2 上，完成一次本人 Plus 账户真实只读查询，
返回五小时与周额度窗口。仓库只保留验证结论，不保存账户邮箱、令牌或实际额度快照。
自动测试通过独立伪 CLI 验证握手顺序、UTF-8 分块、通知穿插、异常响应、超时、错误脱敏和子进程回收，
不依赖测试机器登录 Codex。

协议依据：[官方 App Server 文档](https://learn.chatgpt.com/docs/app-server)，
并与本机生成的 JSON Schema 核对。生成的完整协议文件留在 .local 中，不提交。
