import assert from "node:assert/strict";
import test from "node:test";
import { DesktopLifecycle } from "../src/desktop/lifecycle.js";
import type { BackendSession, LifecycleState, RuntimeControlStatus, ShutdownMode } from "../src/domain/lifecycle.js";
import { AppError } from "../src/shared/errors.js";

function gate() {
  let release!: () => void;
  const waiting = new Promise<void>((done) => { release = done; });
  return { waiting, release };
}
class Backend implements BackendSession {
  owned = true;
  pid = 123;
  starts = 0;
  stops: { mode: ShutdownMode; external: boolean }[] = [];
  activity: RuntimeControlStatus = { instance: "test-instance", pid: 123, stopping: false, shutdownMode: null, activeOperations: 1, activeRunId: "run-one", paused: false };
  startGate: ReturnType<typeof gate> | undefined;
  stopGate: ReturnType<typeof gate> | undefined;
  statusError = false;
  stopError = false;
  async start() { this.starts++; await this.startGate?.waiting; return { url: `http://127.0.0.1:${this.pid}`, pid: this.pid, owned: this.owned }; }
  async status() { if (this.statusError) throw new AppError("RUNTIME_UNREACHABLE", "test"); return { ...this.activity }; }
  async close(mode: ShutdownMode = "cancel", external = false) {
    this.stops.push({ mode, external });
    if (this.stopError) throw new AppError("RUNTIME_STOP_TIMEOUT", "test");
    await this.stopGate?.waiting;
  }
  async escalate() { this.stops.push({ mode: "cancel", external: false }); this.stopGate?.release(); }
}

test("生命周期切换互斥，等待结束前不能宣称停止或启动第二个服务", async () => {
  const backend = new Backend(); backend.startGate = gate();
  const phases: LifecycleState["phase"][] = [];
  const entered = gate();
  const lifecycle = new DesktopLifecycle(() => backend, (state) => { phases.push(state.phase); if (state.phase === "starting") entered.release(); });
  const starting = lifecycle.start();
  await entered.waiting;
  assert.equal(lifecycle.snapshot().phase, "starting");
  assert.throws(() => lifecycle.start(), { code: "LIFECYCLE_BUSY" });
  backend.startGate.release(); await starting;
  backend.stopGate = gate();
  const stopping = lifecycle.stop("wait");
  await Promise.resolve();
  assert.equal(lifecycle.snapshot().phase, "stopping");
  assert.throws(() => lifecycle.restart("wait"), { code: "LIFECYCLE_BUSY" });
  backend.stopGate.release(); await stopping;
  assert.equal(lifecycle.snapshot().phase, "stopped");
  assert.equal(backend.starts, 1);
  assert.deepEqual(phases, ["starting", "running", "stopping", "stopped"]);
});

test("受控重启必须等待旧后台结束，再创建新连接", async () => {
  const old = new Backend(); const next = new Backend(); next.pid = 456;
  let count = 0;
  const lifecycle = new DesktopLifecycle(() => ++count === 1 ? old : next);
  await lifecycle.start(); old.stopGate = gate();
  const restarting = lifecycle.restart("wait"); await Promise.resolve();
  assert.equal(count, 1); assert.equal(next.starts, 0);
  old.stopGate.release(); await restarting;
  assert.equal(lifecycle.snapshot().connection?.pid, 456);
  assert.deepEqual(old.stops, [{ mode: "wait", external: false }]);
});

test("等待式停止可以显式升级为取消，不能重复派发停止操作", async () => {
  const backend = new Backend(); const lifecycle = new DesktopLifecycle(() => backend);
  await lifecycle.start(); backend.stopGate = gate();
  const stopping = lifecycle.stop("wait"); await Promise.resolve();
  backend.activity.shutdownMode = "cancel";
  await lifecycle.check();
  assert.equal(lifecycle.snapshot().mode, "cancel", "Reflect cancellation requested by another authenticated controller");
  await lifecycle.escalate(); await stopping;
  assert.deepEqual(backend.stops.map((stop) => stop.mode), ["wait", "cancel"]);
  assert.equal(lifecycle.snapshot().phase, "stopped");
});

test("外部服务默认只断开连接，停止必须单独指定且不能通过自有重启停止", async () => {
  const backend = new Backend(); backend.owned = false;
  const lifecycle = new DesktopLifecycle(() => backend); await lifecycle.start();
  assert.throws(() => lifecycle.stop("wait"), { code: "EXTERNAL_SERVICE" });
  assert.throws(() => lifecycle.restart("wait"), { code: "EXTERNAL_SERVICE" });
  await lifecycle.stop("wait", true);
  assert.deepEqual(backend.stops, [{ mode: "wait", external: true }]);
});

test("连接故障恢复仅重新核对连接，不自动重启进程或重发任务", async () => {
  const backend = new Backend(); const lifecycle = new DesktopLifecycle(() => backend);
  await lifecycle.start(); backend.statusError = true;
  await lifecycle.check(); assert.equal(lifecycle.snapshot().phase, "disconnected");
  await lifecycle.start(); assert.equal(backend.starts, 1); assert.equal(backend.stops.length, 0);
  backend.statusError = false; await lifecycle.check();
  assert.equal(lifecycle.snapshot().phase, "running");
  assert.equal(backend.starts, 1); assert.equal(backend.stops.length, 0);
});

test("退出失败显示故障，重启不得越过失败直接创建新服务", async () => {
  const backend = new Backend(); let instances = 0;
  const lifecycle = new DesktopLifecycle(() => { instances++; return backend; });
  await lifecycle.start(); backend.stopError = true;
  await assert.rejects(lifecycle.restart("wait"), { code: "RUNTIME_STOP_TIMEOUT" });
  assert.equal(lifecycle.snapshot().phase, "failed"); assert.equal(instances, 1);
});

test("后台意外退出只记录故障，不自动重启；快照不能被界面修改", async () => {
  const backend = new Backend(); let exit!: () => void;
  const lifecycle = new DesktopLifecycle((callback) => { exit = callback; return backend; });
  await lifecycle.start();
  const snapshot = lifecycle.snapshot(); snapshot.connection!.pid = 999;
  assert.equal(lifecycle.snapshot().connection?.pid, 123);
  exit(); assert.equal(lifecycle.snapshot().code, "DESKTOP_BACKEND_EXITED");
  assert.equal(backend.starts, 1);
});

test("启动失败保留错误供用户处理，只有再次显式启动才创建新会话", async () => {
  const bad = new Backend(); bad.statusError = true;
  const good = new Backend(); let sessions = 0;
  const lifecycle = new DesktopLifecycle(() => ++sessions === 1 ? bad : good);
  await assert.rejects(lifecycle.start(), { code: "RUNTIME_UNREACHABLE" });
  assert.equal(lifecycle.snapshot().phase, "failed"); assert.equal(sessions, 1);
  await lifecycle.start();
  assert.equal(lifecycle.snapshot().phase, "running"); assert.equal(sessions, 2);
});
