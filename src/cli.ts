import { existsSync } from "node:fs";
import { createApp } from "./app.js";
import { ConfigManager } from "./config/manage.js";
import { loadConfig } from "./config/load.js";
import { AppError } from "./shared/errors.js";
import { TaskService } from "./tasks/service.js";

const help = `用法：npm start -- 命令 [--config 文件路径]
  status | tasks | preview | demo
  config init [源配置] | show | set 键 JSON值 | restore
  task list | show ID | add JSON文件 | import JSON数组文件
  task update JSON文件 --revision N
  task enable ID --revision N | disable ID --revision N | delete ID --revision N
  task history ID
  runs prepare 任务ID | list 任务ID | show 运行ID
  storage init | check | backup 新备份文件
默认优先 config/local.json，否则 config/example.json。demo 使用模拟数据和内存数据库。
runs prepare 只保存 queued 记录和指令快照，不提交任务。`;

function takeOption(args: string[], option: string): string | undefined {
  const index = args.indexOf(option);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--") || index !== args.lastIndexOf(option)) {
    throw new AppError("INVALID_ARGUMENT", `${option} 需要唯一的参数值。`);
  }
  args.splice(index, 2);
  return value;
}

function invalid(): never { throw new AppError("INVALID_ARGUMENT", "命令或参数无效，请运行 npm start -- help 查看用法。"); }

async function main(): Promise<unknown> {
  const args = process.argv.slice(2);
  const explicitConfig = takeOption(args, "--config");
  const revisionText = takeOption(args, "--revision");
  const command = args.shift() ?? "help";
  if (["help", "--help", "-h"].includes(command)) { console.log(help); return; }
  const configPath = explicitConfig ?? (command === "demo" || !existsSync("config/local.json") ? "config/example.json" : "config/local.json");
  const action = args[0];
  const value = args[1];
  const needsRevision = command === "task" && ["update", "enable", "disable", "delete"].includes(action ?? "");
  const revision = revisionText === undefined ? undefined : Number(revisionText);
  if (needsRevision ? !Number.isSafeInteger(revision) || revision! < 1 : revision !== undefined) invalid();
  if (!["status", "tasks", "preview", "demo", "config", "task", "runs", "storage"].includes(command)) invalid();
  if (command === "task" && !(action === "list" && args.length === 1
    || ["show", "add", "import", "update", "enable", "disable", "delete", "history"].includes(action ?? "") && args.length === 2)) invalid();
  if (command === "runs" && (!["prepare", "list", "show"].includes(action ?? "") || args.length !== 2)) invalid();
  if (command === "storage" && !(action === "backup" && args.length === 2 || ["init", "check"].includes(action ?? "") && args.length === 1)) invalid();

  if (command === "config") {
    const manager = new ConfigManager(action === "init" ? explicitConfig ?? "config/local.json" : configPath);
    if (action === "init" && args.length <= 2) return manager.init(value ?? "config/example.json");
    if (action === "show" && args.length === 1) return manager.show();
    if (action === "restore" && args.length === 1) return manager.restore();
    if (action === "set" && args.length === 3 && value) {
      let parsed: unknown;
      try { parsed = JSON.parse(args[2]!); } catch {
        if (["provider", "limitId", "tasksFile", "codex.executable", "codex.home", "storage.databasePath"].includes(value)) parsed = args[2]!;
        else throw new AppError("INVALID_ARGUMENT", "配置值必须是 JSON，例如 20、true 或 []；字符串配置也可直接填文本。");
      }
      return manager.set(value, parsed);
    }
    invalid();
  }

  const config = await loadConfig(configPath);
  const app = createApp(command === "demo" ? { ...config, provider: "mock", storage: { databasePath: ":memory:" } } : config);
  try {
    if (args.length === 0) {
      if (command === "status") return await app.status();
      if (command === "tasks") return await app.tasks();
      if (command === "preview" || command === "demo") return await app.preview();
    }
    if (command === "task") {
      const store = await app.storage();
      if (action === "import" && args.length === 2 && value) {
        return { imported: await new TaskService(store).import(value) };
      }
      const service = await app.taskService();
      if (action === "list" && args.length === 1) return await store.tasks.list();
      if (args.length !== 2 || !value) invalid();
      if (action === "show") {
        const task = await store.tasks.get(value);
        if (!task) throw new AppError("TASK_NOT_FOUND", "任务不存在或已归档。");
        return task;
      }
      if (action === "add") return await service.add(value);
      if (action === "update") return await service.update(value, revision!);
      if (action === "enable" || action === "disable") return await service.enable(value, action === "enable", revision!);
      if (action === "delete") { await store.tasks.remove(value, revision!); return { archived: value }; }
      if (action === "history") return await store.tasks.revisions(value);
    }
    if (command === "runs" && args.length === 2 && value) {
      const store = await app.storage();
      if (action === "prepare") { await app.taskService(); return await store.runs.create(value); }
      if (action === "list") return await store.runs.listByTask(value);
      if (action === "show") {
        const run = await store.runs.get(value);
        if (!run) throw new AppError("RUN_NOT_FOUND", "运行记录不存在。");
        return run;
      }
    }
    if (command === "storage") {
      const store = await app.storage();
      if (action === "init" && args.length === 1) { await app.taskService(); return await store.check(); }
      if (action === "check" && args.length === 1) return await store.check();
      if (action === "backup" && args.length === 2 && value) {
        await store.check();
        return { backup: store.database.backup(value) };
      }
    }
    invalid();
  } finally { await app.close(); }
}

main().then((result: unknown) => {
  if (result !== undefined) console.log(JSON.stringify(result, null, 2));
}).catch((error: unknown) => {
  const code = error instanceof AppError ? error.code : "COMMAND_FAILED";
  const message = error instanceof Error ? error.message : "未知错误";
  console.error(JSON.stringify({ error: { code, message } }));
  process.exitCode = 1;
});
