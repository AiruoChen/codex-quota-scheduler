import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { SqliteStore } from "../src/storage/sqlite-store.js";
import { SelectedResource } from "../src/management/gui/selected-resource.js";
import { recoveryGuidance, outputLabel } from "../src/management/gui/recovery-model.js";

test("一万条运行记录按状态/项目分页，列表不泄露正文或输出，稳定按创建顺序返回", async (t) => {
  const clock = { now: () => new Date("2026-10-25T00:00:00Z") };
  const store = new SqliteStore(":memory:", clock), ids: string[] = [];
  try {
    await store.tasks.create({ id: "history", name: "History fixture", projectDir: resolve(".local/history-fixture"), promptFile: resolve(".local/unused.md"), enabled: true, priority: 1, session: { mode: "new" } }, "private history prompt");
    store.database.transaction(() => {
      const update = store.database.connection.prepare("UPDATE runs SET data_json=? WHERE id=?");
      for (let index = 0; index < 10000; index++) {
        const run = store.runs.insert("history"); ids.push(run.id);
        update.run(JSON.stringify({ ...run, status: index % 3 === 0 ? "queued" : index % 3 === 1 ? "succeeded" : "needs_attention", output: "private history output" }), run.id);
      }
    });
    const start = performance.now();
    const page = await store.runs.query({ search: "history-fixture", status: "needs_attention", offset: 25, limit: 25 });
    t.diagnostic(`10000-run filtered page: ${(performance.now() - start).toFixed(1)} ms`);
    assert.equal(page.total, 3333); assert.equal(page.items.length, 25);
    assert.ok(!JSON.stringify(page).includes("private history"));
    assert.equal((await store.runs.query({ search: "", status: "all", offset: 25, limit: 25 })).items[0]?.id, ids[9974]);
    assert.equal((await store.runs.query({ search: "%_", status: "all", offset: 0, limit: 25 })).total, 0);
    for (const input of [{ offset: -1 }, { limit: 101 }, { status: "invalid" }]) await assert.rejects(store.runs.query({ search: "", status: "all", offset: 0, limit: 25, ...input } as Parameters<typeof store.runs.query>[0]), { code: "INVALID_ARGUMENT" });
  } finally { store.close(); }
});

test("详情合并同记录读取；切换记录或关闭后，旧响应与旧错误不能覆盖当前详情", async () => {
  const resolveRead = new Map<string, (value: string) => void>();
  const rejectRead = new Map<string, (reason: Error) => void>();
  const shown: string[] = []; let calls = 0;
  const resource = new SelectedResource<string>((id) => { calls++; return new Promise((done, reject) => { resolveRead.set(id, done); rejectRead.set(id, reject); }); }, (value) => shown.push(value));
  resource.select("first"); const first = resource.load(); assert.equal(resource.load(), first); assert.equal(calls, 1);
  resource.select("second"); const second = resource.load(); resolveRead.get("second")!("second result"); await second;
  resolveRead.get("first")!("old result"); await first; assert.deepEqual(shown, ["second result"]);
  resource.select("closed"); const closed = resource.load(); resource.select(null); rejectRead.get("closed")!(new Error("old request error")); await closed;
  assert.deepEqual(shown, ["second result"]);
});

test("未确认、取消和失败输出保留部分语义，未知进程不能被引导为已退出", () => {
  assert.equal(outputLabel({ status: "succeeded", output: "complete" }), "最终输出");
  for (const status of ["running", "needs_attention", "failed", "cancelled"] as const) assert.equal(outputLabel({ status, output: "partial" }), "已保存的部分输出");
  assert.match(recoveryGuidance("execution_owner_unknown"), /无法确认/);
  assert.match(recoveryGuidance("submitted_pending"), /禁止重复提交/);
  assert.match(recoveryGuidance("unrecognized"), /准确回合/);
});
