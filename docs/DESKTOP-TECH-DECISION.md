# ADR 001：最小桌面客户端技术选型

日期：2026-10-25。状态：已采用并完成本机 Windows x64 运行及打包验证。

## 决策与候选方案

采用 Electron 45.0.0、TypeScript 严格模式与现有本机 HTTP 管理页面，使用 @electron/packager 20.3.0 生成便携目录。
两个桌面依赖固定精确版本并进入 package-lock.json；后端继续仅依赖 Node 内置库。

本机实测该 Electron 自带 Node.js 24.22.0，node:sqlite 使用 SQLite 3.53.4，可访问项目数据库。
源码开发及 CLI 基线仍为 Node.js 22.12+；用户运行便携客户端无需另装 Node.js/npm。

| 方案 | 与当前项目的关系 | 本次判断 |
| --- | --- | --- |
| Electron | 继续使用 TypeScript、现有页面及服务；自带 Chromium 和 Node | 本期采用，较少改动即可验证独立运行；接受便携目录较大的代价 |
| Tauri | 可复用页面；Node 服务需打包为 sidecar，并引入 Rust 构建及 WebView2 验证 | 保留为后续评估，首块不同时引入第二套工具链 |
| Windows 原生 UI | 需新增 UI 技术栈，并重新连接现有服务 | 首版没有足够收益支持重写现有界面 |

结论针对本项目代码和交付目标，未声称通用性能排名或安装包大小基准。

## 运行结构

```text
Electron 主进程
  ├─ 安全窗口：本机页面，sandbox=true，contextIsolation=true，nodeIntegration=false
  ├─ 用户数据目录与单实例锁
  └─ Electron 可执行文件的 Node 模式子进程
       └─ 现有 ManagementService / HTTP / SQLite / Codex 适配器
```

后端通过官方 ELECTRON_RUN_AS_NODE 模式运行，保持 process.execPath 可执行 Node 脚本及标准 npm Codex 启动器。
模式仅设置于后台子进程，不修改用户系统环境；去除 NODE_OPTIONS/NODE_PATH，避免把启动注入参数带入后台。
需要保留 Electron 的 RunAsNode 能力；后续如使用 fuses，不能直接关闭该开关。

评估过 utilityProcess，但本项目已有通过 process.execPath 启动 Node CLI 的调用方式；首块先复用普通 Node 子进程模型。
后续若切换进程模型，需重新验证 npm 启动器、SQLite 与退出行为。

## 边界和生命周期

- 管理页面继续只调用回环 HTTP，无 Node/preload 桥接，会话、CSRF 和数据库执行权继续有效。
- 生命周期模块新增本地状态窗口，仅此窗口通过隔离 preload 调用固定的生命周期协议；Electron 适配器校验准确窗口、顶层 frame 和本地 URL，不提供通用 IPC 或 shell。
- 窗口仅允许管理页根路径及 hash 导航；拒绝弹窗、webview、权限请求和外部页面导航。
- 后台就绪后通过实例记录核对 PID/实例身份；界面得不到控制密钥。
- 自有后台保持 IPC 生命周期连接，关闭时可选择等待当前任务完成或明确请求取消；先暂停派发，等待结果落盘及进程退出。
- 父进程消失时，IPC 断开通知后台正常退出；若断开发生在启动等待期间，也会检查连接状态。
- --config 连接已有外部服务时不取得停止所有权；退出桌面不停止它。只有单独选择停止外部服务并确认，才调用其经过身份校验的控制接口。
- 默认新建独立、空任务的模拟配置；损坏配置、孤立数据库、遗留实例不自动覆盖或清理。

## 打包方式

首块交付自带运行时的 Windows x64 便携目录，入口 CodexQuotaScheduler.exe。
根据当前源码选择编译产物，并按白名单加入页面与文档，不复制仓库、测试、开发依赖、个人配置或运行数据。
本期采用 asar=false，保证普通 Node 子进程可以直接读取后端脚本；ASAR 不是加密或凭据保护措施。
已有输出目录不自动覆盖，避免删除正在使用的分发目录；移走整个旧目录后可重新打包。

产物尚未签名；安装器、图标定制、托盘、通知、更新与旧数据迁移向导由后续模块实施。

## 官方依据

2026-10-25 核对以下资料，并以安装后的二进制实测兼容性：

- [Electron 环境变量](https://www.electronjs.org/docs/latest/api/environment-variables)：Node 模式与环境变量行为。
- [Electron 安全建议](https://www.electronjs.org/docs/latest/tutorial/security)：页面隔离、沙箱及导航边界。
- [Electron utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process)：候选后台进程模型。
- [Electron Packager 配置](https://electron.github.io/packager/main/interfaces/Options.html)：平台、版本、ASAR 与打包选项。
- [Tauri 前置条件](https://tauri.app/start/prerequisites/)与 [Node sidecar](https://tauri.app/learn/sidecar-nodejs/)：对比方案依赖。
