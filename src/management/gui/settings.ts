import type { ConfigDetail } from "../contracts.js";
import { api } from "./api.js";
import { $, busy } from "./dom.js";
import type { UiContext } from "./context.js";

export function settingsView(context: UiContext) {
  let config: ConfigDetail | undefined;
  function fill() {
    const value = $<HTMLSelectElement>("config-key").value.split(".").reduce<unknown>((data, key) => data && typeof data === "object" ? (data as Record<string, unknown>)[key] : undefined, config?.saved);
    $<HTMLInputElement>("config-value").value = value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value);
  }
  async function logs() { $("runtime-logs").textContent = (await api<{ text: string }>("/api/logs")).text || "尚无日志"; }
  async function load() {
    config = await api<ConfigDetail>("/api/config");
    $("active-config").textContent = JSON.stringify(config.active, null, 2);
    $("config-difference").textContent = JSON.stringify(config.active) === JSON.stringify(config.saved) ? "配置已生效" : "存在待重启配置";
    fill(); await logs();
  }
  $("config-key").addEventListener("change", fill);
  const form = $<HTMLFormElement>("config-form");
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void busy(form.querySelector<HTMLButtonElement>("button[type=submit]")!, async () => {
      let value: unknown = $<HTMLInputElement>("config-value").value;
      try { value = JSON.parse(String(value)); } catch { /* Plain strings remain valid input. */ }
      await context.act("config-set", { key: $<HTMLSelectElement>("config-key").value, value }, "配置已校验、备份并保存。重启服务后生效，队列保持暂停。"); await load();
    });
  });
  $("refresh-logs").onclick = () => { void busy($<HTMLButtonElement>("refresh-logs"), logs); };
  return { load };
}
