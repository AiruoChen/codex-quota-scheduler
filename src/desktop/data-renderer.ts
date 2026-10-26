import type { DesktopDataView } from "../domain/data-transfer.js";
declare global {
  interface Window {
    desktopData: { read(): Promise<DesktopDataView>; openDirectory(): Promise<void>; action(action: string, value?: string, confirmed?: boolean): Promise<void>; onFocus(listener: () => void): () => void };
  }
}
const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
let current: DesktopDataView | null = null, working = false;
const reasons: Record<string, string> = {
  EXTERNAL_SERVICE: "当前连接外部服务。请由其所有者安全停止，或在后台服务菜单中单独确认停止，再管理数据。",
  MIGRATION_SOURCE_ACTIVE: "当前或源配置仍有服务、写锁或活动进程。请先安全停止；遗留记录需在异常与恢复中显式核对。",
  MIGRATION_CHANGED: "预检后源数据已变化，请重新选择配置并预检。原件和当前配置保持不变。",
  MIGRATION_TARGET_EXISTS: "目标或暂存目录已存在，不能覆盖。请保留失败信息后重新预检。",
  MIGRATION_BACKUP_INVALID: "备份清单或校验和无效，不能恢复。请检查其他备份。",
  STORAGE_VERSION: "数据库来自更新版本，请使用匹配客户端，或选择匹配的旧备份。",
  DESKTOP_DOWNGRADE: "数据已由更新客户端使用，不能直接回退。请使用匹配版本或把匹配备份导入为新配置。",
  MIGRATION_PINNED_CONFIG: "当前由 --config 固定配置。请安全退出，以默认方式启动后导入或切换。",
};
function render(value: DesktopDataView) {
  current = value;
  byId("data-location").textContent = `客户端 ${value.version} · 支持数据库模式 ${value.schema}\n用户数据：${value.directory}\n活动配置：${value.config}`;
  const preview = byId("data-preview"); preview.hidden = !value.preview;
  if (value.preview) {
    const item = value.preview;
    byId("data-preview-detail").textContent = `来源：${item.source}\n数据库：${item.sourceDatabase}\n目标（新副本）：${item.target}\n来源 ${item.provider === "mock" ? "模拟" : "真实 Codex"} · 模式 ${item.schema}\n任务 ${item.tasks} · 版本 ${item.versions} · 运行 ${item.runs} · 待核对/运行中 ${item.attention}`;
  }
  byId("data-backup").textContent = value.backup ? `最近备份：${value.backup}\n恢复时选择其中的 config.json，将导入为新副本。备份包含私人任务和运行记录，请妥善保管。` : "尚无本次会话创建的备份。";
  const select = byId<HTMLSelectElement>("data-profiles"), selected = select.value;
  select.replaceChildren();
  for (const profile of value.profiles) {
    const option = document.createElement("option"); option.value = profile.id;
    option.textContent = `${profile.active ? "当前 · " : ""}${profile.id === "default" ? "原默认配置" : profile.id} · ${profile.config}`;
    select.append(option);
  }
  if (value.profiles.some((profile) => profile.id === selected)) select.value = selected;
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-transfer]")) button.disabled = working || value.busy;
  byId<HTMLButtonElement>("data-commit").disabled ||= !value.preview || !byId<HTMLInputElement>("data-confirm").checked;
}
async function refresh() { try { render(await window.desktopData.read()); } catch { byId("data-result").textContent = "数据管理状态不可用，请保留窗口检查。"; } }
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-transfer]")) {
  button.addEventListener("click", () => {
    const action = button.dataset.transfer!;
    if (action !== "preview" && !byId<HTMLInputElement>("data-confirm").checked) { byId("data-result").textContent = "请先勾选确认，核对操作范围。"; return; }
    working = true; if (current) render(current);
    byId("data-result").textContent = "正在处理，请保留窗口。等待任务完成期间不会强制取消。";
    const value = action === "commit" ? current?.preview?.token : action === "switch" ? byId<HTMLSelectElement>("data-profiles").value : undefined;
    void window.desktopData.action(action, value, true).then(() => {
      byId("data-result").textContent = "操作已完成。导入或切换后请显式启动后台；队列保持暂停。";
      byId<HTMLInputElement>("data-confirm").checked = false;
    }).catch((error: unknown) => {
      const message = String(error), code = Object.keys(reasons).find((key) => message.includes(key));
      byId("data-result").textContent = code ? reasons[code]! : "操作未完成。原数据与备份已保留，请检查配置、权限、磁盘空间或损坏记录后重试。";
    }).finally(() => { working = false; void refresh(); });
  });
}
byId<HTMLInputElement>("data-confirm").addEventListener("change", () => { if (current) render(current); });
byId<HTMLButtonElement>("data-open-directory").addEventListener("click", () => {
  const button = byId<HTMLButtonElement>("data-open-directory"); button.disabled = true;
  void window.desktopData.openDirectory().then(() => { byId("data-result").textContent = "已请求在文件管理器中打开用户数据目录。"; })
    .catch(() => { byId("data-result").textContent = "无法打开用户数据目录，请检查目录是否存在和系统文件管理器状态。"; })
    .finally(() => { button.disabled = false; });
});
window.desktopData.onFocus(() => { byId("data-management").scrollIntoView(); void refresh(); });
window.desktopLifecycle.onChange(() => { void refresh(); });
void refresh();
