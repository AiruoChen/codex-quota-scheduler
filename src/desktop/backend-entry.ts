import { runForeground } from "../runtime/service.js";
import { AppError } from "../shared/errors.js";

try {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !args[0]) throw new AppError("INVALID_ARGUMENT", "缺少桌面后台配置。");
  await runForeground(args[0], 0, { stopOnDisconnect: true });
} catch (error) {
  const code = error instanceof AppError ? error.code : "DESKTOP_BACKEND_FAILED";
  if (process.connected) {
    await new Promise<void>((done) => process.send?.({ event: "runtime_failed", code }, () => done()));
    process.disconnect?.();
  }
  console.error(JSON.stringify({ error: { code, message: "桌面后台未能启动或安全结束，请检查本地运行状态。" } }));
  process.exitCode = 1;
}
