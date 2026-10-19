import { createApp } from "./app.js";
import { loadConfig } from "./config/load.js";
import { AppError } from "./shared/errors.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args.shift() ?? "help";
  if (command === "help" || command === "--help" || command === "-h") {
    console.log("用法：npm start -- <status|tasks|preview|demo> [--config 文件路径]\n默认配置：config/example.json（模拟数据）。真实读取使用 --config config/codex.example.json。demo 等同于 preview。");
    return;
  }
  if (!["status", "tasks", "preview", "demo"].includes(command)) {
    throw new AppError("INVALID_COMMAND", `未知命令：${command}`);
  }
  let configPath = "config/example.json";
  if (args.length > 0) {
    if (args.length !== 2 || args[0] !== "--config" || !args[1]) {
      throw new AppError("INVALID_ARGUMENT", "可选参数为 --config 文件路径");
    }
    configPath = args[1];
  }
  const app = createApp(await loadConfig(configPath));
  const result = command === "status" ? await app.status()
    : command === "tasks" ? await app.tasks() : await app.preview();
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error: unknown) => {
  const code = error instanceof AppError ? error.code : "COMMAND_FAILED";
  const message = error instanceof Error ? error.message : "未知错误";
  console.error(JSON.stringify({ error: { code, message } }));
  process.exitCode = 1;
});
