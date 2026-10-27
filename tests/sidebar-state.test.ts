import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { parseSidebarState, readSidebarState } from "../src/adapters/codex/sidebar-state.js";
import { bindSidebarProject, displayedProject, readSidebarCursor, sidebarCursor } from "../src/adapters/codex/sidebar-projects.js";
import { defaultCodexOptions } from "../src/adapters/codex/launcher.js";
import type { ThreadChoice } from "../src/domain/catalog.js";

import { sidebarFixture } from "./fixtures/sidebar-state.js";
const choice: ThreadChoice = { id: "thread-1", name: "Chat", projectId: null, projectKnown: true, cwd: resolve("."), updatedAt: null };
const home = resolve(".local/synthetic-codex-home"), live = new Set(["official-project-1"]);
function parsed(value = sidebarFixture(home)) { const result = parseSidebarState(value, home); assert.equal(result.status, "ready"); if (result.status !== "ready") throw new Error("Expected snapshot"); return result.snapshot; }

test("desktop explicit legacy mapping enriches display without rewriting canonical project or granting permissions", () => {
  const snapshot = parsed(), linked = bindSidebarProject(choice, snapshot, live);
  assert.equal(linked.projectId, null); assert.equal(displayedProject(linked), "official-project-1");
  assert.deepEqual(linked.projectBinding, { source: "desktop_state", status: "assigned", projectId: "official-project-1" });
  assert.equal(Object.hasOwn(linked, "permissionsVerified"), false);
  assert.equal(JSON.stringify(snapshot).includes("PRIVATE_TOKEN"), false);
  assert.equal(displayedProject(bindSidebarProject({ ...choice, id: "unassigned-thread" }, snapshot, live)), null);
  assert.equal(displayedProject(bindSidebarProject({ ...choice, id: "unknown-thread" }, snapshot, live)), undefined);
});

test("canonical non-null assignment wins; missing host, unknown mapping, deleted project and non-pending assignment remain unknown", () => {
  const original = sidebarFixture(home);
  assert.equal(displayedProject(bindSidebarProject({ ...choice, projectId: "new-canonical" }, parsed(), live)), "new-canonical");
  for (const change of [
    (v: typeof original) => { v["thread-project-membership-host-ids"]["thread-1"] = "other-host"; },
    (v: typeof original) => { v["app-server-project-id-by-legacy-project-id-by-host"][`local:${home}`]!["legacy-project"] = "not-live"; },
    (v: typeof original) => { v["app-server-projects-migration-by-host"][`local:${home}`]!.pendingThreadAssignmentIds = []; },
  ]) { const value = sidebarFixture(home); change(value); assert.equal(displayedProject(bindSidebarProject(choice, parsed(value), live)), undefined); }
  assert.equal(displayedProject(bindSidebarProject(choice, parsed(), new Set())), undefined);
});

test("contradictory projectless markers and ambiguous ID maps are not guessed from paths", () => {
  const value = sidebarFixture(home); value["projectless-thread-ids"].push("thread-1");
  assert.equal(bindSidebarProject(choice, parsed(value), live).projectBinding?.status, "conflict");
  const snapshot = parsed();
  const duplicate = { ...snapshot, serverIds: new Map([...snapshot.serverIds, ["second-legacy", "official-project-1"]]) };
  assert.equal(bindSidebarProject(choice, duplicate, live).projectBinding?.status, "conflict");
  assert.equal(displayedProject(bindSidebarProject({ ...choice, id: "same-cwd-other-chat" }, snapshot, live)), undefined);
});

test("desktop schema and exact local home are validated; completed migration defers to the protocol", () => {
  assert.equal(parseSidebarState(sidebarFixture(home), resolve("other-home")).status, "source_mismatch");
  assert.equal(parseSidebarState({}, home).status, "unsupported");
  for (const mutate of [
    (v: ReturnType<typeof sidebarFixture>) => { v["app-server-projects-migration-by-host"][`local:${home}`]!.version = 2; },
    (v: ReturnType<typeof sidebarFixture>) => { v["local-projects"]["legacy-project"].id = "wrong-id"; },
    (v: ReturnType<typeof sidebarFixture>) => { v["app-server-projects-migration-by-host"][`local:${home}`]!.projectsMigrated = false; },
  ]) { const value = sidebarFixture(home); mutate(value); assert.equal(parseSidebarState(value, home).status, "unsupported"); }
  const completed = sidebarFixture(home); completed["app-server-projects-migration-by-host"][`local:${home}`]!.threadAssignmentsMigrated = true;
  assert.equal(parseSidebarState(completed, home).status, "not_needed");
});

test("pagination binds scope, project filter and membership revision; unrelated preferences do not invalidate it", () => {
  const snapshot = parsed(), value = sidebarCursor("opaque", "scope", "project", snapshot.revision);
  assert.equal(readSidebarCursor(value, "scope", "project", snapshot.revision), "opaque");
  for (const input of [["changed", "project", snapshot.revision], ["scope", "different", snapshot.revision], ["scope", "project", "changed"]]) {
    assert.throws(() => readSidebarCursor(value, input[0]!, input[1]!, input[2]!), { code: "CATALOG_CHANGED" });
  }
  const preferences = { ...sidebarFixture(home), unrelatedSecret: "DIFFERENT_PRIVATE_VALUE", sidebarWidth: 500 };
  assert.equal(parseSidebarState(preferences, home).status, "ready");
  assert.equal(parsed(preferences).revision, snapshot.revision);
});

test("file reader is bounded, read-only and rejects custom routing, missing data and invalid state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sidebar-state-"));
  try {
    const options = { ...defaultCodexOptions, home: directory }, file = join(directory, ".codex-global-state.json");
    assert.equal((await readSidebarState(options)).status, "missing");
    const data = JSON.stringify(sidebarFixture(directory)); await writeFile(file, data);
    assert.equal((await readSidebarState(options)).status, "ready"); assert.equal(await readFile(file, "utf8"), data);
    assert.equal((await readSidebarState({ ...options, args: ["--code-mode-host", "ws://fixture.invalid"] })).status, "source_mismatch");
    await writeFile(file, "not json PRIVATE_TOKEN"); assert.equal((await readSidebarState(options)).status, "unsupported");
    await writeFile(file, "x".repeat(8 * 1024 * 1024 + 1)); assert.equal((await readSidebarState(options)).status, "unsupported");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
