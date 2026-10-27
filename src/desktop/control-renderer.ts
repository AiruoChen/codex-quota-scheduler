import type { LifecycleCommand, LifecycleView } from "../domain/lifecycle.js";

declare global {
  interface Window {
    desktopLifecycle: { read(): Promise<LifecycleView>; command(command: LifecycleCommand): Promise<void>;
      openNotice(id: string): Promise<void>;
      onChange(listener: (view: LifecycleView) => void): () => void };
  }
}
const title = document.querySelector<HTMLHeadingElement>("#status-title")!;
const detail = document.querySelector<HTMLParagraphElement>("#status-detail")!;
const activity = document.querySelector<HTMLParagraphElement>("#activity")!;
const error = document.querySelector<HTMLParagraphElement>("#error")!;
const names = { idle: "准备连接后台", starting: "正在启动或连接后台", running: "后台运行正常", stopping: "正在安全停止后台",
  stopped: "后台已停止", failed: "后台需要处理", disconnected: "后台连接中断" };
const guidance: Record<string, string> = {
  RUNTIME_STALE: "已记录的进程已退出。可先核对并清理服务记录，数据库执行权仍需单独核对。",
  DESKTOP_BACKEND_EXITED: "后台意外退出。请核对服务记录和原任务结果，程序不会自动重发。",
  RUNTIME_RECORD_INVALID: "服务记录损坏。请保留原文件及数据库，按恢复说明核对，不能直接覆盖。",
  RUNTIME_INSTANCE_CHANGED: "服务身份已变化。当前连接不会向新实例发送停止命令，请核对后重新连接。",
  RUNTIME_STOPPING: "服务正在停止，请等待或查询状态，不会创建第二个后台。",
  RUNTIME_INCOMPATIBLE: "已有服务版本不支持当前管理协议。请先手动升级，客户端不会自动停止旧服务。",
};
function render(view: LifecycleView) {
  const busy = view.phase === "starting" || view.phase === "stopping" || !!view.dataBusy;
  title.textContent = names[view.phase];
  detail.textContent = view.intent ? ({ exit: "退出前先暂停派发，再按所选方式处理当前任务。", stop: "停止后台会阻止新任务派发。",
    restart: "重启后配置重新加载，队列保持暂停。", "stop-external": "这是外部启动的服务。确认后将停止它，其他连接也会受到影响。",
    recover: "仅清理已确认退出的服务记录；不修复数据库执行权，不恢复队列，也不重发任务。" }[view.intent])
    : view.code ? guidance[view.code] ?? "请检查配置、运行日志和已有任务状态；可以重试连接，不会自动释放执行权。"
      : view.phase === "stopping" ? view.mode === "wait" ? "正在等待当前任务完成并保存结果；可明确改为请求取消。" : "已请求取消，正在等待终止确认和结果保存。"
        : view.connection ? `${view.connection.owned ? "客户端自有后台" : "连接已有外部服务"} · PID ${view.connection.pid}`
          : view.phase === "stopped" ? "任务和历史记录已保留。再次启动后队列保持暂停。" : "默认使用模拟环境。只有显式恢复真实队列后才会派发任务。";
  activity.textContent = view.activity ? `活动操作 ${view.activity.activeOperations} · 队列${view.activity.paused ? "已暂停" : "可派发"}${view.activity.activeRunId ? " · 存在运行中任务" : ""}` : "尚无可验证的活动状态";
  error.textContent = view.code ?? "";
  const desktop = view.desktop;
  document.querySelector<HTMLElement>("#tray-notice")!.hidden = !desktop?.closeNotice;
  document.querySelector<HTMLElement>("#desktop-reason")!.textContent = desktop?.reason
    ? `${desktop.reason} · 桌面集成不可用时请保留窗口，或选择安全退出。` : "";
  document.querySelector<HTMLElement>("#desktop-status")!.textContent = `${desktop?.trayAvailable ? "托盘可用" : "托盘不可用"} · 系统通知${desktop?.notificationSupported ? "通道支持" : "通道不可用"} · 本地通知记录始终保留`;
  for (const [id, checked] of [["notifications-enabled", desktop?.settings?.enabled], ["quota-notifications-enabled", desktop?.settings?.quotaReset]] as const) {
    const input = document.querySelector<HTMLInputElement>(`#${id}`)!; input.checked = !!checked; input.disabled = !desktop?.settings || view.phase === "stopping";
  }
  const history = document.querySelector<HTMLElement>("#notification-history")!;
  history.replaceChildren();
  const deliveries: Record<string, string> = { disabled: "系统通知已关闭 · 已记录", attempted: "已请求系统显示", unsupported: "系统通道不可用 · 已记录", failed: "系统显示请求失败 · 已记录", local: "批量状态变化 · 仅本地记录" };
  for (const notice of desktop?.notices ?? []) {
    const item = document.createElement("article"), title = document.createElement("strong"), body = document.createElement("p"), meta = document.createElement("small"), open = document.createElement("button");
    title.textContent = notice.title; body.textContent = notice.body;
    meta.textContent = `${new Date(notice.createdAt).toLocaleString("zh-CN")} · ${deliveries[notice.delivery] ?? "已记录"}`;
    open.textContent = "打开对应页面"; open.onclick = () => { open.disabled = true; void window.desktopLifecycle.openNotice(notice.id).catch(() => { error.textContent = "通知来源不可验证或记录已过期，请核对当前配置。"; }).finally(() => { open.disabled = false; }); };
    item.append(title, body, meta, open); history.append(item);
  }
  if (!desktop?.notices.length) history.textContent = "尚无通知记录。历史任务不会在首次连接时集中弹出。";
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-command]")) {
    const command = button.dataset.command as LifecycleCommand;
    const ready = view.phase === "running";
    const confirming = view.intent !== null && !busy;
    let enabled = false;
    if (command === "start") enabled = !busy && !view.intent && !ready;
    if (command === "status") enabled = !!view.connection && !view.intent;
    if (command === "restart" || command === "stop") enabled = ready && view.connection?.owned === true && !view.intent;
    if (command === "stop-external") enabled = ready && view.connection?.owned === false && !view.intent;
    if (command === "recover") enabled = !busy && !view.intent && ["RUNTIME_STALE", "DESKTOP_BACKEND_EXITED"].includes(view.code ?? "");
    if (command === "exit") enabled = !busy && !view.intent;
    if (command === "keep-open") enabled = view.phase !== "stopping" && (ready || !!view.intent);
    if (command === "hide") enabled = !!desktop?.trayAvailable && view.phase !== "stopping";
    if (command === "show") enabled = ready && !view.intent;
    if (command === "pause") enabled = ready && !view.activity?.paused && !view.intent;
    if (command === "wait") enabled = confirming;
    if (command === "cancel") enabled = confirming && view.intent !== "recover" || view.phase === "stopping" && view.mode === "wait";
    button.disabled = !enabled;
    if (view.dataBusy) button.disabled = true;
    button.hidden = view.phase === "stopping" ? command !== "status" && !(command === "cancel" && view.mode === "wait")
      : view.intent && !busy ? !["wait", "cancel", "keep-open", "hide"].includes(command) || command === "cancel" && view.intent === "recover"
        : !enabled;
    if (command === "wait") button.textContent = view.intent === "recover" ? "确认核对服务记录" : view.intent === "restart" ? "等待完成后重启"
      : view.intent === "exit" ? "等待完成后退出" : "确认停止并等待完成";
    if (command === "cancel") button.textContent = view.phase === "stopping" ? "改为请求取消" : view.intent === "restart" ? "请求取消后重启"
      : view.intent === "exit" ? "请求取消后退出" : "请求取消并停止";
    if (command === "keep-open") button.textContent = view.intent ? "继续保留窗口" : "返回管理界面";
    if (command === "hide") button.textContent = view.intent === "exit" ? "留在托盘" : desktop?.closeNotice ? "知道了，隐藏到托盘" : "隐藏到托盘";
  }
}
for (const [id, command] of [["notifications-enabled", "notifications-toggle"], ["quota-notifications-enabled", "quota-notifications-toggle"]] as const) {
  document.querySelector<HTMLInputElement>(`#${id}`)!.addEventListener("change", () => {
    void window.desktopLifecycle.command(command).catch(() => { error.textContent = "通知偏好未能保存，请核对桌面状态文件。"; }).finally(() => { void window.desktopLifecycle.read().then(render); });
  });
}
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-command]")) {
  button.addEventListener("click", () => {
    button.disabled = true;
    void window.desktopLifecycle.command(button.dataset.command as LifecycleCommand).catch(() => {
      error.textContent = "操作未完成，请查看当前后台状态。";
    }).finally(() => { void window.desktopLifecycle.read().then(render); });
  });
}
window.desktopLifecycle.onChange(render);
void window.desktopLifecycle.read().then(render);
