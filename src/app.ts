import { AppServerQuotaProvider } from "./adapters/codex/app-server-provider.js";
import { MockQuotaProvider } from "./adapters/mock/quota-provider.js";
import type { AppConfig } from "./config/load.js";
import { systemClock, type Clock } from "./domain/ports.js";
import { QuotaMonitor } from "./monitor/quota-monitor.js";
import { evaluateQueue } from "./scheduler/evaluate.js";
import { loadTasks } from "./tasks/load.js";

export function createApp(config: AppConfig, clock: Clock = systemClock) {
  const provider = config.provider === "mock" ? new MockQuotaProvider(clock) : new AppServerQuotaProvider();
  const monitor = new QuotaMonitor(provider);
  return {
    status: () => monitor.sample(),
    tasks: () => loadTasks(config.tasksFile),
    async preview() {
      const [snapshot, tasks] = await Promise.all([monitor.sample(), loadTasks(config.tasksFile)]);
      return {
        mode: "preview_only",
        snapshot,
        decision: evaluateQueue(snapshot, tasks, config, clock.now(), false),
        note: "仅预览，不发送指令；尚未接入执行器、持久化队列及去重机制。",
      };
    },
  };
}
