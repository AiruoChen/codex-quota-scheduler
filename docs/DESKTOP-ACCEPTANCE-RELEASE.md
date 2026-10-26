# 桌面客户端验收与发布

本模块针对 Windows x64 安装包。它从一个干净的源码提交生成安装包、运行自动验收、绑定提交与 SHA256、复验候选包，并提供受控发布入口。报告中的协议替身只会使用隔离测试目录与固定测试指令；它不代表真实 Codex 账户验收。稳定版门禁还要求实际签名、连续 24 小时运行和独立人工证据。没有这些证据时只能生成候选版。

## 自动验收做了什么

`scripts/acceptance.mjs` 使用当前源码，依次执行类型与边界检查、单元测试、模拟演示、便携目录打包、安装器打包、桌面 GUI 烟测、八个后台生命周期场景、隔离安装/迁移/升级/卸载烟测、程序载荷隐私检查和桌面稳定性烟测。每一步失败即停止；未执行项保持 `pending`，不能被报告成通过。

稳定性烟测启动打包后的客户端，但 Codex 协议由项目内测试替身提供。它显式创建与入队十个测试任务、启动调度、等待每个任务恰好提交一次，关闭窗口到托盘，并在真实经过的墙钟时间内检查重复额度查询、本地通知记录、后台、子进程、内存和事件上限。任何时钟长缺口、中断、重复提交、缺失持续查询或通知记录、遗留子进程或超限都会使报告失败。报告中的 `monitorUpdates` 是观察到的额度状态更新次数，`notificationCount` 是本地脱敏通知记录数；系统通知是否实际显示仍需人工验收。CI 使用 60 秒，只满足候选版最低门禁；稳定版要求 `--soak-seconds 86400`，不能用调快模拟时钟替代。

自动结果写入 `.release/<名称>/report.json`、`report.md`。原始子进程日志与协议替身审计只在被 Git 忽略的 `.local/<名称>/`；公开报告由固定字段白名单生成，不发布任务正文、账户、输出、登录数据、完整个人路径或原始日志。报告含源码提交、源码是否干净、安装包 SHA256、目标平台、各检查实际耗时与数量、稳定性测量；缺少任一证据都不能通过门禁。

## 本地运行

在 Windows x64 干净检出的源码上，安装 Node.js 22.12+、npm，并准备项目已锁定的 Electron 与 NSIS 构建依赖。选一个尚未使用的输出名称：

```powershell
npm.cmd ci --ignore-scripts
node node_modules/electron/install.js
npm.cmd run build
node --experimental-sqlite scripts/acceptance.mjs --output-name candidate-001 --soak-seconds 60
node scripts/verify-release.mjs --directory .release/candidate-001/bundle --channel candidate
```

`--output-name` 只接受英文字母、数字、下划线和连字符；构建拒绝覆盖已有输出。安装烟测会创建独立测试产品标识、注册项和被 Git 忽略的项目内测试目录，完成后保留诊断供核对。源码有未提交改动时可以运行测试并生成报告，但不会生成可发布的 bundle。验收脚本不访问真实 Codex CLI 或登录目录。

候选 bundle 包含安装包、其 `.sha256`、`release.json`、`report.json`、`report.md`、`RELEASE-NOTES.md`、`README.txt`、`bundle.json` 和 `SHA256SUMS`。`verify-release.mjs` 逐个重算哈希、检查额外文件与符号链接、核对提交/版本/安装包 SHA256，并重新评估门禁。校验和用于完整性检查，不能替代发布者身份签名。

## CI 与候选发布

`.github/workflows/ci.yml` 的 Linux/Windows 作业继续执行 `check`、`test`、`demo`。Windows desktop 作业运行统一验收；失败时仅上传脱敏报告，成功的仓库**默认分支 push** 才上传 `release-candidate-<run_id>-<run_attempt>`。PR 的合成提交与其他分支不能充当发布来源。原始 `.local` 日志不上传。

维护者在 GitHub Actions 中确认对应**默认分支 push** 的 CI 全部成功，且源码确实经过审查，然后从默认分支手动运行 `Publish verified candidate`，填写该 CI 的数字 run ID。仓库应将 `release-publish` 配置为受保护的 Environment，由有权限的维护者审核。工作流先只读核对来源 run、准确 attempt、产物、哈希与候选门禁，再在 `contents: write` 作业中重新下载和复验。发布脚本先创建草稿，核对 GitHub 上每个上传附件的 SHA256，再公开为 prerelease；标签形如 `v0.3.0-rc.<run_id>.<attempt>`。若上传或复验失败，草稿保持未发布，应人工核对，脚本不会覆盖既有标签。

新工作流须先进入仓库默认分支，GitHub Actions 的手动触发入口才可用。不要从 PR CI 的 artifact、单独复制的安装包或原始测试日志直接创建 Release。

## 稳定版的额外证据

稳定版发布前必须针对**同一个源码提交和同一个最终安装包 SHA256**完成以下项目。可将 [人工证据模板](../release/manual-evidence.example.json) 复制到本机 `.local/release-manual.json` 后填写；模板里的 `pending` 和占位哈希不是通过证据。

| ID | 必须亲自核对的内容 |
| --- | --- |
| `clean_windows` | 在独立且未预装 Node.js/npm 的 Windows x64 机器或干净虚拟机安装、启动模拟模式、升级和卸载；记录系统版本与结果。 |
| `real_account` | 用户明确指定测试任务与目录后，在本人登录账户上检查只读额度、手动/自动提交边界和结果；记录固定结论，不将任务正文或登录信息上传。 |
| `native_notifications` | 在目标 Windows 设置中实际显示或禁用原生通知，检查托盘、点击、去重及脱敏。 |
| `display_scaling` | 在 100%、150%、200% 缩放以及中文/空格路径下核对操作可达、输入与输出不截断。 |
| `fault_recovery` | 演练断网、登录失效、睡眠唤醒、端口占用、进程崩溃、写入失败、损坏数据库与升级中断；确认无盲目重发/自动解锁。 |
| `p0_walkthrough` | 按 [客户端需求 D01–D15](DESKTOP-CLIENT-REQUIREMENTS.md) 完整走查，含首次引导、配置与诊断、客户端内帮助、安全退出、迁移及备份。 |

在具备代码签名证书的独立 Windows x64 环境中，构建并完成连续 24 小时验收：

```powershell
# 以下三个值只放在可信本机环境或受保护密钥库，不写入命令历史、源码或日志。
$env:CQS_SIGNING_PFX_BASE64 = '<secret>'
$env:CQS_SIGNING_PASSWORD = '<secret>'
$env:CQS_SIGNING_THUMBPRINT = '<40-digit hex>'
node --experimental-sqlite scripts/acceptance.mjs --output-name stable-001 --soak-seconds 86400 --sign yes
node scripts/verify-release.mjs --directory .release/stable-001/bundle --channel stable --manual .local/release-manual.json
```

签名脚本需要 Windows SDK 的 `signtool.exe`，对安装器签名并加时间戳；门禁重新验证签名状态、预期证书指纹和时间戳。它只验证安装器签名，不能据此声称包内每个 PE 均已单独签名。签名凭据、个人任务和原始验收记录不得提交 Git。人工证据由真实执行者核对后填写 `reviewer`、`observedAt` 与状态，必须与报告版本、源码提交及最终签名安装器 SHA256 完全一致，且在 30 天内。

验证通过后，由具备 GitHub Release 写入权限的维护者在同一可信机器上设置 `GITHUB_REPOSITORY=AiruoChen/codex-quota-scheduler`，用 `gh auth login` 登录，使用与本次报告提交**相同**的成功 CI push run ID：

```powershell
$env:GITHUB_REPOSITORY = 'AiruoChen/codex-quota-scheduler'
node scripts/publish-release.mjs --directory .release/stable-001/bundle --run-id <successful-push-run-id> --channel stable --manual .local/release-manual.json
```

稳定版工具还要求该提交已进入默认分支，且该标签不存在；先草稿、复核已上传附件 SHA256，再公开 `v0.3.0`。发布操作者应留存独立环境的详细人工记录，但 GitHub Release 只携带脱敏验收摘要。若任一条件缺失，保持候选状态，不用人工勾选代替缺失的 24 小时、签名或真实账户结果。

GitHub 托管 runner 的单个作业上限为 6 小时；自托管作业虽可更长，超过 24 小时还可能受到作业令牌有效期影响。因此持续 24 小时的稳定版构建采用独立 Windows 环境本地运行，再经同提交 CI 与发布脚本核对。参考 [GitHub Actions 限制](https://docs.github.com/en/enterprise-cloud@latest/actions/reference/limits) 与 [工作流语法](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)。

## 中断与撤回

任何检查失败、断电、计时缺口或进程退出不完整都会留下失败/待验报告，不生成稳定版通过证据。已创建但尚未公开的草稿需要核对 GitHub 附件和标签后人工处理；脚本拒绝覆盖标签或自动删除附件。若已公开的版本发现问题，应通过 GitHub 的正常撤回/说明流程处理，不依赖客户端静默更新。升级前仍须在客户端选择备份并安全退出；安装器拒绝覆盖仍在运行的程序，卸载保留用户数据。
