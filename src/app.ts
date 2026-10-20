import { AppServerQuotaProvider } from "./adapters/codex/app-server-provider.js";
import { MockQuotaProvider } from "./adapters/mock/quota-provider.js";
import type { AppConfig } from "./config/load.js";
import { systemClock, type Clock } from "./domain/ports.js";
import { QuotaMonitor } from "./monitor/quota-monitor.js";
import { evaluateQueue } from "./scheduler/evaluate.js";
import { TaskService } from "./tasks/service.js";
import type { SqliteStore } from "./storage/sqlite-store.js";
import { ManualExecutionService } from "./executor/manual-service.js";
import { AppServerQuotaFeed } from "./adapters/codex/quota-feed.js";
import { ContinuousQuotaMonitor } from "./monitor/continuous-monitor.js";
import { SqliteMonitorRepository } from "./storage/monitor-repository.js";
import { digest } from "./monitor/recognize.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { SchedulerService } from "./scheduler/service.js";
import { SqliteSchedulerRepository } from "./storage/scheduler-repository.js";

export function createApp(config: AppConfig, clock: Clock = systemClock) {
  const provider = config.provider === "mock" ? new MockQuotaProvider(clock) : new AppServerQuotaProvider(config.codex, clock);
  const monitor = new QuotaMonitor(provider);
  const streamKey = digest([config.provider, config.limitId, config.reservePercent, config.quotaMaxAgeMs,
    config.provider === "codex" ? [config.codex.executable, config.codex.args, config.codex.home ?? process.env.CODEX_HOME ?? join(homedir(), ".codex")] : null]);
  let store: SqliteStore | undefined;
  let opening: Promise<SqliteStore> | undefined;
  let closed = false;
  let continuous: ContinuousQuotaMonitor | undefined;
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
  async function monitoring() {
    const current = await storage();
    if (!continuous) {
      continuous = new ContinuousQuotaMonitor(config.provider === "codex" ? new AppServerQuotaFeed(config.codex, clock) : provider,
        new SqliteMonitorRepository(current.database, streamKey, config, clock), clock);
    }
    return continuous;
  }
  return {
    status: () => monitor.sample(), storage, taskService, monitoring,
    async scheduling() {
      const current = await storage();
      return new SchedulerService(new SqliteSchedulerRepository(current.database, streamKey, config.scheduler?.trigger ?? "available", config, clock),
        await monitoring(), new ManualExecutionService(config, current, clock), { provider: config.provider, persistent: config.storage.databasePath !== ":memory:" });
    },
    async execution() { return new ManualExecutionService(config, await storage(), clock); },
    async tasks() { await taskService(); return (await storage()).tasks.list(); },
    async close() { closed = true; try { await continuous?.close(); } finally { await opening?.catch(() => {}); store?.close(); } },
    async preview() {
      await taskService();
      const [snapshot, tasks] = await Promise.all([monitor.sample(), (await storage()).tasks.list()]);
      return {
        mode: "preview_only",
        snapshot,
        decision: evaluateQueue(snapshot, tasks, config, clock.now(), false),
        note: config.storage.databasePath === ":memory:"
          ? "模拟演示使用内存存储，不写入任务数据库，也不发送指令。"
          : "仅预览，不发送指令；自动执行需要显式入队并启动调度。",
      };
    },
  };
}
