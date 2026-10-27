import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { ConfigManager } from "../../config/manage.js";
import { AppError } from "../../shared/errors.js";
import { ManagementService } from "../../management/service.js";
import type { RuntimeLogger } from "../../runtime/log.js";
import type { ShutdownMode } from "../../domain/lifecycle.js";
import { browserModules } from "../../management/gui-assets.js";

export interface ServerOptions {
  port: number;
  instance: string;
  controlToken: string;
  logger: RuntimeLogger;
  onStop(mode?: ShutdownMode): void;
}

export async function serveManagement(service: ManagementService, options: ServerOptions) {
  const csrf = randomBytes(32).toString("hex");
  const cookie = `cqs_${options.instance.slice(0, 12)}=${randomBytes(32).toString("hex")}`;
  const assets = new Map(await Promise.all([
    ...["index.html", "style.css"].map(async (name) => [name, await readFile(new URL(`../../management/public/${name}`, import.meta.url))] as const),
    ...browserModules.map(async (name) => [`gui/${name}.js`, await readFile(new URL(`../../management/gui/${name}.js`, import.meta.url))] as const),
  ]));
  let origin = "";
  let stopping = false;
  let shutdownMode: ShutdownMode | null = null;
  let closePromise: Promise<void> | undefined;
  const requests = new Set<Promise<void>>();
  const server = createServer((request, response) => {
    const flushed = new Promise<void>((done) => { response.once("finish", done); response.once("close", done); });
    const handling = handle(request, response).then(() => flushed).finally(() => { requests.delete(handling); });
    requests.add(handling);
    void handling.catch(() => {});
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 1000;

  function reply(response: ServerResponse, status: number, data: unknown) {
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(data));
  }
  async function handle(request: IncomingMessage, response: ServerResponse) {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      if (request.headers.host !== new URL(origin).host) throw new AppError("HTTP_FORBIDDEN", "仅允许从本机地址访问。");
      if (request.headers.origin !== undefined && request.headers.origin !== origin
        || request.headers["sec-fetch-site"] === "cross-site") throw new AppError("HTTP_FORBIDDEN", "请求来源不匹配。");
      const url = new URL(request.url ?? "/", origin);
      if (url.origin !== origin) throw new AppError("HTTP_FORBIDDEN", "请求地址不匹配。");
      const path = url.pathname;
      if (path === "/api/runtime" || path === "/api/runtime/stop") {
        if (!equal(request.headers.authorization, `Bearer ${options.controlToken}`)
          || request.headers["x-runtime-instance"] !== options.instance) throw new AppError("HTTP_FORBIDDEN", "运行实例不匹配。");
        if (path === "/api/runtime" && request.method === "GET") return reply(response, 200, { instance: options.instance, pid: process.pid, stopping, shutdownMode, ...service.activity() });
        if (path === "/api/runtime/stop" && request.method === "POST") {
          const mode = url.searchParams.get("mode") ?? "cancel";
          if (mode !== "wait" && mode !== "cancel") throw new AppError("INVALID_ARGUMENT", "未知停止方式。");
          if (shutdownMode !== "cancel") shutdownMode = mode;
          service.beginShutdown(shutdownMode);
          reply(response, 202, { instance: options.instance, pid: process.pid, stopping: true });
          if (!stopping) { stopping = true; setImmediate(() => options.onStop(shutdownMode!)); }
          return;
        }
        throw new AppError("HTTP_NOT_FOUND", "接口不存在。");
      }
      const assetName = path === "/" ? "index.html" : path.slice(1);
      if (request.method === "GET" && assets.has(assetName)) {
        if (assetName === "index.html") response.setHeader("Set-Cookie", `${cookie}; HttpOnly; SameSite=Strict; Path=/`);
        response.writeHead(200, { "Content-Type": assetName.endsWith(".html") ? "text/html; charset=utf-8" : assetName.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8" });
        response.end(assets.get(assetName)); return;
      }
      if (!request.headers.cookie?.split(/;\s*/).includes(cookie)) throw new AppError("HTTP_FORBIDDEN", "请先打开管理页面。");
      if (request.method === "GET") {
        const store = await service.app.storage();
        const id = url.searchParams.get("id") ?? "";
        if (path === "/api/bootstrap") return reply(response, 200, { csrf });
        if (path === "/api/state") return reply(response, 200, await service.state());
        if (path === "/api/tasks") return reply(response, 200, await service.tasks());
        if (path === "/api/tasks/page") return reply(response, 200, await store.tasks.query({ search: url.searchParams.get("search") ?? "",
          enabled: (url.searchParams.get("enabled") ?? "all") as "all" | "enabled" | "disabled",
          offset: Number(url.searchParams.get("offset") ?? 0), limit: Number(url.searchParams.get("limit") ?? 25) }));
        if (path === "/api/task") {
          const task = await store.tasks.get(id);
          if (!task) throw new AppError("TASK_NOT_FOUND", "任务不存在或已归档。");
          return reply(response, 200, task);
        }
        if (path === "/api/runs") {
          const runs = await store.runs.recent(50, Number(url.searchParams.get("offset") ?? 0));
          return reply(response, 200, runs.map(({ promptSnapshot: _prompt, output: _output, taskSnapshot, ...run }) => ({ ...run, name: taskSnapshot.name })));
        }
        if (path === "/api/run") {
          const run = await store.runs.get(id);
          if (!run) throw new AppError("RUN_NOT_FOUND", "运行记录不存在。");
          return reply(response, 200, { run, events: store.execution.events(id), recovery: (await service.recovery()).repository.events(id) });
        }
        if (path === "/api/config") return reply(response, 200, { active: service.config, saved: await new ConfigManager(service.configPath).show() });
        if (path === "/api/logs") return reply(response, 200, { text: options.logger.tail() });
      }
      if (request.method === "POST" && path === "/api/action") {
        if (!equal(request.headers["x-csrf-token"], csrf)) throw new AppError("HTTP_FORBIDDEN", "页面已失效，请重新加载。");
        if (request.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") throw new AppError("HTTP_BAD_REQUEST", "请求必须是 JSON。");
        const body = await readBody(request);
        if (typeof body !== "object" || !body || Array.isArray(body)) throw new AppError("HTTP_BAD_REQUEST", "请求格式无效。");
        const { action, ...data } = body as Record<string, unknown>;
        if (typeof action !== "string") throw new AppError("HTTP_BAD_REQUEST", "缺少操作名称。");
        const result = ["monitor-start", "monitor-stop", "scheduler-start", "scheduler-stop", "sample"].includes(action)
          ? await service.loopAction(action) : await service.action(action, data);
        reply(response, ["run", "run-start", "inspect", "reconcile", "scheduler-start", "monitor-start"].includes(action) ? 202 : 200, result);
        return;
      }
      throw new AppError("HTTP_NOT_FOUND", "接口不存在。");
    } catch (error) {
      const code = error instanceof AppError ? error.code : "OPERATION_FAILED";
      const status = code === "HTTP_FORBIDDEN" ? 403 : code === "HTTP_TOO_LARGE" ? 413
        : code === "HTTP_NOT_FOUND" || code.endsWith("_NOT_FOUND") ? 404
        : /BUSY|CONFLICT|ALREADY|REQUIRED|STOPPING|NOT_STARTED/.test(code) ? 409 : error instanceof AppError ? 400 : 500;
      if (status === 500) options.logger.write("request_failed", code);
      if (!response.headersSent) reply(response, status, { error: { code, message: error instanceof AppError ? error.message : "操作失败，请检查运行状态或配置。" } });
      else response.end();
    }
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  origin = `http://127.0.0.1:${address.port}`;
  return { url: origin, close(mode: ShutdownMode = "cancel"): Promise<void> {
    service.beginShutdown(mode);
    if (shutdownMode !== "cancel") shutdownMode = mode;
    closePromise ??= (async () => {
      stopping = true;
      // Keep authenticated status/stop available while waiting; writes are already rejected.
      await service.prepareStop(mode);
      // Stop accepting work before waiting for cancellation and durable finalization.
      const drained = new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeIdleConnections(); });
      // Browser preconnect sockets may never send headers. Drain handlers and response writes first,
      // then close the remaining HTTP connections without truncating in-flight persistence work.
      try {
        while (requests.size) await Promise.allSettled([...requests]);
        server.closeAllConnections();
        await drained;
      } finally { await service.close(mode); }
    })();
    return closePromise;
  } };
}

function equal(value: unknown, expected: string): boolean {
  if (typeof value !== "string") return false;
  const actual = Buffer.from(value);
  const target = Buffer.from(expected);
  return actual.length === target.length && timingSafeEqual(actual, target);
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let length = 0;
    let settled = false;
    const chunks: Buffer[] = [];
    request.on("data", (buffer: Buffer) => {
      if (settled) return;
      length += buffer.length;
      if (length > 512 * 1024) {
        settled = true; chunks.length = 0;
        reject(new AppError("HTTP_TOO_LARGE", "请求超过 512 KiB，请缩短指令。"));
      } else chunks.push(buffer);
    });
    request.once("error", reject);
    request.once("aborted", () => reject(new AppError("HTTP_BAD_REQUEST", "请求已中断。")));
    request.once("end", () => {
      if (settled) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown); }
      catch { reject(new AppError("HTTP_BAD_REQUEST", "JSON 格式无效。")); }
    });
  });
}
