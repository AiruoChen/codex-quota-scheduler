import { AppServerQuotaProvider } from "./adapters/codex/app-server-provider.js";
import { MockQuotaProvider } from "./adapters/mock/quota-provider.js";
import type { AppConfig } from "./config/load.js";
import { systemClock, type Clock } from "./domain/ports.js";
import { QuotaMonitor } from "./monitor/quota-monitor.js";
import { evaluateQueue } from "./scheduler/evaluate.js";
import { TaskService } from "./tasks/service.js";
import type { SqliteStore } from "./storage/sqlite-store.js";
import { ManualExecutionService } from "./executor/manual-service.js";

export function createApp(config: AppConfig, clock: Clock = systemClock) {
  const provider = config.provider === "mock" ? new MockQuotaProvider(clock) : new AppServerQuotaProvider(config.codex, clock);
  const monitor = new QuotaMonitor(provider);
  let store: SqliteStore | undefined;
  let opening: Promise<SqliteStore> | undefined;
  let closed = false;
  async function storage(): Promise<SqliteStore> {
    if (closed) throw new Error("Application is closed");
    opening ??= (async () => {
      const { SqliteStore } = await import("./storage/sqlite-store.js");
      store = new SqliteStore(config.storage.databasePath, clock);
      return store;
    })();
    return opening;
  }
  async function taskService(): Promise<TaskService> {
    const current = await storage();
    const service = new TaskService(current);
    await service.seed(config.tasksFile);
    return service;
  }
  return {
    status: () => monitor.sample(),
    storage,
    taskService,
    async execution() { return new ManualExecutionService(config, await storage(), clock); },
    async tasks() { await taskService(); return (await storage()).tasks.list(); },
    async close() { closed = true; await opening?.catch(() => {}); store?.close(); },
    async preview() {
      await taskService();
      const [snapshot, tasks] = await Promise.all([monitor.sample(), (await storage()).tasks.list()]);
      return {
        mode: "preview_only",
        snapshot,
        decision: evaluateQueue(snapshot, tasks, config, clock.now(), false),
        note: config.storage.databasePath === ":memory:"
          ? "模拟演示使用内存存储，不写入任务数据库，也不发送指令。"
          : "仅预览，不发送指令；任务定义已持久化，自动调度与执行器尚未接入。",
      };
    },
  };
}
