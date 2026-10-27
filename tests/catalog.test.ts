import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CodexCatalog } from "../src/adapters/codex/catalog.js";
import { loadConfig } from "../src/config/load.js";
import { resolveTaskTarget } from "../src/management/task-target.js";
import { realpath } from "node:fs/promises";

async function setup(scenario = "catalog-paged") {
  const dir = await mkdtemp(join(tmpdir(), "catalog-fixture-")); await mkdir(join(dir, "second"));
  const config = await loadConfig("config/codex.example.json"), trace = join(dir, "trace.jsonl");
  config.codex = { ...config.codex, executable: process.execPath, args: [resolve("tests/fixtures/fake-execution.mjs"), "--scenario", scenario, "--project", dir, "--trace", trace], requestTimeoutMs: 2000, shutdownTimeoutMs: 200 };
  return { dir, config, trace, catalog: new CodexCatalog(config.codex), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("U01/U03: real wire IDs, paginated model/project catalog and dual selector keep unknown separate from unassigned", async () => {
  const env = await setup();
  try {
    const first = await env.catalog.models(), next = await env.catalog.models(first.nextCursor!);
    assert.equal(first.items[0]?.id, "fixture-model"); assert.equal(next.items[0]?.id, "fixture-model-2"); assert.equal(first.scope, next.scope);
    assert.ok(first.items[0]?.efforts.includes("minimal"));
    const projects = await env.catalog.projects(), empty = await env.catalog.projects(projects.nextCursor!);
    assert.equal(projects.items[0]?.id, "official-project-1"); assert.equal(projects.items[0]?.roots.length, 2); assert.deepEqual(empty.items[0]?.roots, []);
    assert.equal((await env.catalog.threads("official-project-1", undefined, first.scope)).items[0]?.name, "Named fixture chat");
    const none = await env.catalog.threads("none", undefined, first.scope); assert.deepEqual(none.items.map(thread => thread.id), ["unassigned-thread"]);
    assert.equal((await env.catalog.threads()).items.find(thread => thread.id === "unknown-thread")?.projectKnown, false);
    await assert.rejects(env.catalog.threads(undefined, undefined, "0".repeat(64)), { code: "CATALOG_SCOPE_CHANGED" });
    const trace = (await readFile(env.trace, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });
    assert.equal(trace.some(request => ["thread/start", "thread/resume", "turn/start", "turn/interrupt"].includes(request.method ?? "")), false);
    const init = trace.find(request => request.method === "initialize")!; assert.equal((init.params!.capabilities as { experimentalApi: boolean }).experimentalApi, true);
    assert.ok(!JSON.stringify(first).includes("user@example.test")); assert.ok(!JSON.stringify(first).includes("PRIVATE"));
  } finally { await env.cleanup(); }
});

test("U04: resume is metadata-only and blocks unknown effective permissions; new project requires explicit scoped write authorization", async () => {
  const env = await setup();
  try {
    const scope = (await env.catalog.projects()).scope;
    const found = await env.catalog.environment("thread-1", scope);
    assert.equal(found.environment.cwd, await realpath(env.dir)); assert.equal(found.environment.permissionsVerified, false); assert.equal(found.environment.roots.length, 2);
    await assert.rejects(resolveTaskTarget(env.config, join(env.dir, "config/local.json"), { mode: "resume", threadId: "thread-1", cwd: "spoofed" }, scope, "task", "read-only"), { code: "CODEX_ENVIRONMENT_UNVERIFIED" });
    await assert.rejects(resolveTaskTarget(env.config, join(env.dir, "config/local.json"), { mode: "project", projectId: "official-project-1", cwd: env.dir, writableRoots: [] }, scope, "task", "workspace-write"), { code: "PERMISSION_SCOPE_INVALID" });
    const target = await resolveTaskTarget(env.config, join(env.dir, "config/local.json"), { mode: "project", projectId: "official-project-1", cwd: env.dir, writableRoots: [env.dir] }, scope, "task", "workspace-write");
    assert.equal(target.environment.projectId, "official-project-1"); assert.equal(target.environment.roots.length, 2); assert.deepEqual(target.environment.writableRoots, [await realpath(env.dir)]);
    await assert.rejects(resolveTaskTarget(env.config, join(env.dir, "config/local.json"), { mode: "project", projectId: "official-empty-project", cwd: "" }, scope, "task", "read-only"), { code: "INVALID_ARGUMENT" });
    const unassigned = await resolveTaskTarget(env.config, join(env.dir, "config/local.json"), { mode: "unassigned" }, scope, "task", "read-only");
    assert.equal(unassigned.environment.projectId, null); assert.equal(unassigned.environment.projectKnown, true); assert.equal(unassigned.environment.mode, "unassigned");
    const trace = await readFile(env.trace, "utf8"); assert.equal(/"method":"(?:thread\/resume|thread\/start|turn\/start)"/.test(trace), false);
  } finally { await env.cleanup(); }
});

test("U01: account changes during catalog reads discard the whole response", async () => {
  const env = await setup("account-change");
  try { await assert.rejects(env.catalog.models(), { code: "CATALOG_SCOPE_CHANGED" }); }
  finally { await env.cleanup(); }
});

test("U03 regression: projects can exist while every chat is officially unassigned; all-chat lookup remains usable", async () => {
  const env = await setup("catalog-unassigned");
  try {
    const projects = await env.catalog.projects(); assert.ok(projects.items.length);
    assert.equal((await env.catalog.threads(projects.items[0]!.id, undefined, projects.scope)).items.length, 0);
    const all = await env.catalog.threads(undefined, undefined, projects.scope);
    assert.equal(all.items.length, 3); assert.ok(all.items.every(thread => thread.projectKnown && thread.projectId === null));
    assert.ok(all.items.some(thread => thread.name === "Named fixture chat"));
    assert.equal((await env.catalog.threads("none", undefined, projects.scope)).items.length, 3);
    const trace = (await readFile(env.trace, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });
    const queries = trace.filter(request => request.method === "thread/list");
    assert.equal(Object.hasOwn(queries[1]!.params!, "projectId"), false);
    assert.equal(queries[2]!.params!.projectId, null);
    assert.ok(queries.every(request => request.params!.useStateDbOnly === true));
    assert.equal(trace.some(request => ["thread/resume", "thread/start", "turn/start"].includes(request.method ?? "")), false);
  } finally { await env.cleanup(); }
});
