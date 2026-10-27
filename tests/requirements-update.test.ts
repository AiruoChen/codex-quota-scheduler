import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ConfigManager } from "../src/config/manage.js";
import { loadConfig, parseConfig } from "../src/config/load.js";
import { evaluateQuota } from "../src/domain/quota-policy.js";
import { SqliteStore } from "../src/storage/sqlite-store.js";
import type { TaskDefinition } from "../src/domain/task.js";
import type { QuotaSnapshot } from "../src/domain/quota.js";
import { quotaStreamKey } from "../src/monitor/context.js";

const epoch = Date.parse("2026-10-27T00:00:00Z");
const definition: TaskDefinition = { id: "legacy-id", name: "Task", enabled: true, priority: 1, projectDir: resolve("."), promptFile: resolve("unused.md"), session: { mode: "new" } };
const snapshot: QuotaSnapshot = { source: "codex", fetchedAt: new Date(epoch).toISOString(), buckets: [{ id: "codex", name: null, planType: null, reachedType: null,
  windows: [{ slot: "primary", durationMinutes: 300, remainingPercent: 30, usedPercent: 70, resetsAt: new Date(epoch + 10000).toISOString() },
    { slot: "secondary", durationMinutes: 10080, remainingPercent: 20, usedPercent: 80, resetsAt: new Date(epoch + 100000).toISOString() }] }] };

test("U02: generated IDs are unique, persistent and request-idempotent; legacy references survive", async () => {
  const store = new SqliteStore(":memory:");
  try {
    await store.tasks.create(definition, "legacy prompt"); const legacy = await store.runs.create(definition.id);
    const { id: _id, ...fields } = definition, key = randomUUID();
    const first = await store.tasks.createGenerated(fields, "draft", key);
    assert.match(first.id, /^[a-f0-9-]{36}$/); assert.notEqual(first.id, key);
    assert.equal((await store.tasks.createGenerated(fields, "draft", key)).id, first.id);
    assert.notEqual((await store.tasks.createGenerated(fields, "draft", randomUUID())).id, first.id);
    await assert.rejects(store.tasks.createGenerated(fields, "changed draft", key), { code: "TASK_CREATE_CONFLICT" });
    await store.tasks.update(first, "edited", 1); await store.tasks.remove(first.id, 2);
    assert.equal((await store.tasks.createGenerated(fields, "draft", key)).id, first.id);
    assert.equal((await store.runs.get(legacy.id))?.taskId, "legacy-id");
    await assert.rejects(store.tasks.createGenerated(fields, "draft", "not-a-request-id"), { code: "INVALID_ARGUMENT" });
    await store.check();
  } finally { store.close(); }
});

test("U06: full result ordering precedes pagination, editing does not move creation time and ties use IDs", async () => {
  let time = epoch; const store = new SqliteStore(":memory:", { now: () => new Date(time) });
  try {
    for (let index = 0; index < 35; index++) { time = epoch + Math.floor(index / 2) * 1000; await store.tasks.create({ ...definition, id: `id-${String(index).padStart(2, "0")}` }, "body"); }
    const query = { search: "", enabled: "all" as const, offset: 0, limit: 25 };
    const first = await store.tasks.query(query), second = await store.tasks.query({ ...query, offset: 25 });
    assert.equal(first.items[0]?.id, "id-34"); assert.equal(first.total, 35); assert.equal(new Set([...first.items, ...second.items].map(task => task.id)).size, 35);
    assert.deepEqual(first.items.slice(1, 3).map(task => task.id), ["id-32", "id-33"]);
    assert.equal((await store.tasks.query({ ...query, sort: "created_asc" })).items[0]?.id, "id-00");
    time += 10000; const oldest = (await store.tasks.get("id-00"))!; await store.tasks.update({ ...oldest, name: "edited" }, "edit", 1);
    assert.equal((await store.tasks.query(query)).items[0]?.id, "id-34");
    assert.equal((await store.tasks.get("id-00"))?.createdAt, oldest.createdAt);
    await assert.rejects(store.tasks.query({ ...query, sort: "invalid" } as never), { code: "INVALID_ARGUMENT" });
  } finally { store.close(); }
});

test("U07: independent server-duration reserves share the same eligibility guard, including edge values and other windows", async () => {
  const policy = { limitId: "codex", quotaMaxAgeMs: 60000, reservePercent: 10 };
  const check = (fiveHour: number, weekly: number, input = snapshot) => evaluateQuota(input, { ...policy, quotaReserves: { fiveHour, weekly } }, new Date(epoch));
  assert.equal(check(25, 15).status, "available"); assert.equal(check(30, 15).status, "blocked"); assert.equal(check(25, 20).status, "blocked");
  assert.equal(check(0, 0).status, "available"); assert.equal(check(100, 0).status, "blocked");
  const exhausted = structuredClone(snapshot); exhausted.buckets[0]!.windows[1]!.remainingPercent = 0;
  assert.deepEqual(check(0, 0, exhausted), { status: "blocked", reason: "quota_exhausted" });
  const other = structuredClone(snapshot); other.buckets[0]!.windows[0]!.durationMinutes = 60; other.buckets[0]!.windows[0]!.remainingPercent = 5;
  assert.equal(check(0, 0, other).status, "blocked");
  const config = await loadConfig("config/example.json");
  assert.equal(quotaStreamKey(config), quotaStreamKey(parseConfig({ ...config, quotaReserves: undefined }, "config/local.json")));
  assert.notEqual(quotaStreamKey(config), quotaStreamKey({ ...config, quotaReserves: { fiveHour: 0, weekly: 0 } }));
  for (const value of [-1, 101, 1.23, NaN, "20", null]) assert.throws(() => parseConfig({ ...config, quotaReserves: { fiveHour: value, weekly: 10 } }, "config/local.json"));
});

test("U07: pair save is atomic and uses config revision; conflicts and invalid values preserve the draft on disk", async () => {
  const dir = await mkdtemp(join(tmpdir(), "quota-reserves-"));
  try {
    const manager = new ConfigManager(join(dir, "local.json")); await manager.init("config/example.json");
    const original = await manager.snapshot(); assert.equal(original.saved.quotaReserves, undefined);
    await manager.set("quotaReserves", { fiveHour: 12.5, weekly: 20 }, original.revision);
    const saved = await manager.snapshot(); assert.deepEqual(saved.saved.quotaReserves, { fiveHour: 12.5, weekly: 20 });
    await assert.rejects(manager.set("quotaReserves", { fiveHour: 1, weekly: 1 }, original.revision), { code: "CONFIG_CONFLICT" });
    await assert.rejects(manager.set("quotaReserves", { fiveHour: 1, weekly: -1 }, saved.revision));
    assert.deepEqual((await manager.show()).quotaReserves, saved.saved.quotaReserves);
    assert.equal(JSON.parse(await readFile(manager.path + ".bak", "utf8")).quotaReserves, undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
