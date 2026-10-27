import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

/** Mirror metadata with missing project assignments, without touching any real account or remote thread. */
export async function catalogAcceptance(page, directory, checkpoint = () => {}) {
  const { call, evaluate, wait } = page, scope = "a".repeat(64);
  const requests = [], failures = [], held = [];
  let mode = "normal";
  const chat = (id, name, projectKnown = true) => ({ id, name, projectId: null, projectKnown, cwd: directory, updatedAt: null });
  const fulfill = (id, response, status = 200) => call("Fetch.fulfillRequest", { requestId: id, responseCode: status,
    responseHeaders: [{ name: "Content-Type", value: "application/json" }], body: Buffer.from(JSON.stringify(response)).toString("base64") });
  const stop = page.on("Fetch.requestPaused", event => {
    const url = new URL(event.request.url), kind = url.pathname.split("/").at(-1);
    requests.push({ kind, method: event.request.method });
    let response = { source: "codex", scope, items: [], nextCursor: null }, status = 200;
    if (kind === "models") response.items = [{ id: "fixture-model", name: "Fixture model", isDefault: true, efforts: ["low"] }];
    if (kind === "projects") response.items = [{ id: "fixture-project", name: "Fixture project", roots: [directory] }];
    if (kind === "threads") {
      const filter = url.searchParams.get("projectId");
      if (mode === "fail") { status = 503; response = { error: { code: "CATALOG_FIXTURE_UNAVAILABLE", message: "Synthetic catalog unavailable" } }; }
      else if (filter === "fixture-project" && mode === "hold") { held.push(event.requestId); return; }
      else if (!filter) response = { ...response, items: url.searchParams.has("cursor") ? [chat("later-chat", "Older named chat")]
        : [chat("existing-chat", "Existing named chat"), chat("unknown-chat", "Unknown assignment chat", false)], nextCursor: url.searchParams.has("cursor") ? null : "page-2" };
      else if (filter === "none") response.items = [chat("existing-chat", "Existing named chat")];
    }
    if (kind === "environment") response = { scope, environment: { version: 1, mode: "resume", scope, connectionKey: "b".repeat(64),
      projectId: null, projectKnown: true, roots: [], cwd: directory, writableRoots: [], permissionsVerified: false }, limitation: "Synthetic permission remains unverified" };
    void fulfill(event.requestId, response, status).catch(error => failures.push(error));
  });
  checkpoint("catalog-open");
  await call("Fetch.enable", { patterns: [{ urlPattern: "*/api/catalog/*", requestStage: "Request" }] });
  try {
    await evaluate("location.hash='#tasks'"); await wait("!document.getElementById('tasks').hidden");
    await evaluate("document.getElementById('new-task').click()");
    await wait("document.getElementById('task-dialog').open && [...document.querySelector('[name=projectId]').options].some(o=>o.value==='fixture-project')");
    await evaluate("document.querySelector('[name=session]').value='resume';document.querySelector('[name=session]').dispatchEvent(new Event('change'))");
    checkpoint("catalog-all-chats");
    await wait("!document.querySelector('[name=threadId]').disabled && [...document.querySelector('[name=threadId]').options].some(o=>o.textContent.includes('Existing named chat'))");
    assert.equal(await evaluate("document.querySelector('[name=projectId]').value"), "");
    assert.equal(await evaluate("document.querySelector('[name=projectId]').options[0].textContent"), "全部会话（不按项目过滤）");
    assert.equal(await evaluate("!!document.querySelector('input[name=threadId]')"), false);
    await evaluate("document.getElementById('threads-more').click()");
    await wait("[...document.querySelector('[name=threadId]').options].some(o=>o.textContent.includes('Older named chat'))");
    assert.equal(await evaluate("document.querySelector('[name=threadId]').options.length"), 4);
    checkpoint("catalog-project-empty");
    await evaluate("document.querySelector('[name=projectId]').value='fixture-project';document.querySelector('[name=projectId]').dispatchEvent(new Event('change'))");
    await wait("document.getElementById('thread-status').textContent.includes('接口未返回与此项目关联的会话')");
    assert.equal(await evaluate("document.querySelector('[name=threadId]').disabled"), true);
    assert.equal(await evaluate("document.querySelector('[name=threadId]').options.length"), 1);
    await evaluate("document.getElementById('threads-all').click()");
    await wait("[...document.querySelector('[name=threadId]').options].some(o=>o.textContent.includes('Existing named chat'))");
    assert.equal(await evaluate("document.querySelector('[name=projectId]').value"), "");
    await evaluate("document.querySelector('[name=threadId]').value='existing-chat';document.querySelector('[name=threadId]').dispatchEvent(new Event('change'))");
    await wait("document.getElementById('task-environment').textContent.includes('Synthetic permission remains unverified')");
    assert.equal(await evaluate("document.querySelector('[name=projectDir]').readOnly"), true);
    checkpoint("catalog-error-retry"); mode = "fail";
    await evaluate("document.getElementById('threads-retry').click()");
    await wait("document.getElementById('thread-status').textContent.includes('CATALOG_FIXTURE_UNAVAILABLE')");
    assert.equal(await evaluate("document.querySelector('[name=threadId]').disabled"), true);
    mode = "normal"; await evaluate("document.getElementById('threads-retry').click()");
    await wait("!document.querySelector('[name=threadId]').disabled");
    checkpoint("catalog-stale-response"); mode = "hold";
    await evaluate("document.querySelector('[name=projectId]').value='fixture-project';document.querySelector('[name=projectId]').dispatchEvent(new Event('change'))");
    await wait("document.getElementById('threads-retry').disabled");
    await evaluate("document.querySelector('[name=projectId]').value='none';document.querySelector('[name=projectId]').dispatchEvent(new Event('change'))");
    await wait("!document.querySelector('[name=threadId]').disabled");
    assert.equal(held.length, 1);
    await fulfill(held[0], { source: "codex", scope, items: [], nextCursor: null });
    await delay(100); // Let the deliberately delayed response reach the renderer before checking that it was discarded.
    await wait("document.querySelector('[name=projectId]').value==='none' && !document.querySelector('[name=threadId]').disabled");
    assert.equal(await evaluate("document.querySelector('[name=threadId]').options.length"), 2);
    assert.ok(requests.every(request => request.method === "GET")); assert.deepEqual(failures, []);
    return { allChatsDefault: true, emptyProjectExplained: true, explicitShowAll: true, pagination: true, retry: true, staleResponseDiscarded: true, readOnly: true };
  } finally {
    await evaluate("new Promise(resolve=>{const dialog=document.getElementById('task-dialog');if(!dialog.open)return resolve(true);dialog.addEventListener('close',()=>resolve(true),{once:true});dialog.close()})").catch(() => {});
    await call("Fetch.disable"); stop();
  }
}
