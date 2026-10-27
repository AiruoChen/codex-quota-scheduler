import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

/** Mirror canonical-null and explicit legacy desktop memberships without a real account or remote mutation. */
export async function catalogAcceptance(page, directory, checkpoint = () => {}) {
  const { call, evaluate, wait } = page, scope = "a".repeat(64);
  const requests = [], failures = [], held = [];
  let savedAuthorization;
  let mode = "normal";
  const chat = (id, name, projectKnown = true) => ({ id, name, projectId: null, projectKnown, cwd: directory, updatedAt: null });
  const fulfill = (id, response, status = 200) => call("Fetch.fulfillRequest", { requestId: id, responseCode: status,
    responseHeaders: [{ name: "Content-Type", value: "application/json" }], body: Buffer.from(JSON.stringify(response)).toString("base64") });
  const stop = page.on("Fetch.requestPaused", event => {
    const url = new URL(event.request.url), kind = url.pathname.split("/").at(-1);
    requests.push({ kind, method: event.request.method });
    if (kind === "action") {
      savedAuthorization = JSON.parse(event.request.postData);
      void fulfill(event.requestId, { id: "synthetic-consented-task" }).catch(error => failures.push(error)); return;
    }
    let response = { source: "codex", scope, items: [], nextCursor: null }, status = 200;
    if (kind === "models") response.items = [{ id: "fixture-model", name: "Fixture model", isDefault: true, efforts: ["low"] }];
    if (kind === "projects") response.items = [{ id: "fixture-project", name: "Fixture project", roots: [directory] }];
    if (kind === "threads") {
      const filter = url.searchParams.get("projectId");
      if (mode === "legacy") response = { ...response, desktopStatus: "ready", items: [{ ...chat("legacy-chat", "Legacy named chat"),
        projectBinding: { source: "desktop_state", status: "assigned", projectId: "fixture-project" } }] };
      else if (mode === "fail") { status = 503; response = { error: { code: "CATALOG_FIXTURE_UNAVAILABLE", message: "Synthetic catalog unavailable" } }; }
      else if (filter === "fixture-project" && mode === "hold") { held.push(event.requestId); return; }
      else if (!filter) response = { ...response, items: url.searchParams.has("cursor") ? [chat("later-chat", "Older named chat")]
        : [chat("existing-chat", "Existing named chat"), chat("unknown-chat", "Unknown assignment chat", false)], nextCursor: url.searchParams.has("cursor") ? null : "page-2" };
      else if (filter === "none") response.items = [chat("existing-chat", "Existing named chat")];
    }
    if (kind === "environment") response = { scope, ...(mode === "legacy" ? { sidebarProject: { id: "fixture-project", name: "Fixture desktop project", roots: [directory] },
      authorization: { context: "c".repeat(64), cliVersion: "0.160.0-fixture", writableCandidates: [directory], allowedSandboxes: ["read-only", "workspace-write"], readScope: "local-files" } } : {}), environment: { version: 1, mode: "resume", scope, connectionKey: "b".repeat(64),
      projectId: null, projectKnown: true, roots: [], cwd: directory, writableRoots: [], permissionsVerified: false }, limitation: "Synthetic permission remains unverified" };
    void fulfill(event.requestId, response, status).catch(error => failures.push(error));
  });
  checkpoint("catalog-open");
  await call("Fetch.enable", { patterns: [{ urlPattern: "*/api/catalog/*", requestStage: "Request" }, { urlPattern: "*/api/action", requestStage: "Request" }] });
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
    checkpoint("catalog-desktop-membership"); mode = "legacy";
    await evaluate("document.querySelector('[name=projectId]').value='fixture-project';document.querySelector('[name=projectId]').dispatchEvent(new Event('change'))");
    await wait("!document.querySelector('[name=threadId]').disabled && [...document.querySelector('[name=threadId]').options].some(o=>o.textContent.includes('Legacy named chat')&&o.textContent.includes('桌面项目关联'))");
    assert.equal(await evaluate("document.getElementById('thread-status').textContent.includes('已核对本机桌面项目关联')"), true);
    await evaluate("document.querySelector('[name=threadId]').value='legacy-chat';document.querySelector('[name=threadId]').dispatchEvent(new Event('change'))");
    await wait("document.getElementById('task-environment').textContent.includes('Fixture desktop project')");
    assert.equal(await evaluate("document.getElementById('task-environment').textContent.includes('不继承权限')&&document.querySelector('[name=projectDir]').readOnly"), true);
    checkpoint("catalog-explicit-resume-consent");
    assert.equal(await evaluate("!document.getElementById('resume-authorization').hidden&&!document.querySelector('[name=resumeConsent]').checked&&!document.querySelector('[name=resumeReadAll]').checked"), true);
    await evaluate("document.querySelector('[name=name]').value='Synthetic consent only';document.querySelector('[name=prompt]').value='SYNTHETIC_ONLY';document.querySelector('#task-form button[type=submit]').click()");
    await wait("document.getElementById('task-error').textContent.includes('请确认本机文件读取范围')");
    assert.equal(savedAuthorization, undefined);
    await evaluate("document.querySelector('[name=sandbox]').value='workspace-write';document.querySelector('[name=sandbox]').dispatchEvent(new Event('change'))");
    await wait("document.querySelectorAll('#resume-writable-roots input').length===1");
    await evaluate("document.querySelector('[name=resumeConsent]').checked=true;document.querySelector('[name=resumeReadAll]').checked=true;document.querySelector('[name=sandbox]').value='read-only';document.querySelector('[name=sandbox]').dispatchEvent(new Event('change'))");
    assert.equal(await evaluate("!document.querySelector('[name=resumeConsent]').checked&&!document.querySelector('[name=resumeReadAll]').checked"), true);
    await evaluate("document.getElementById('task-dialog').addEventListener('close',()=>{document.getElementById('task-dialog').dataset.acceptanceConsentClosed='done'},{once:true});document.querySelector('[name=sandbox]').value='workspace-write';document.querySelector('[name=sandbox]').dispatchEvent(new Event('change'));document.querySelector('#resume-writable-roots input').click();document.querySelector('[name=resumeReadAll]').click();document.querySelector('[name=resumeConsent]').click();document.querySelector('#task-form button[type=submit]').click()");
    await wait("!document.getElementById('task-dialog').open&&document.getElementById('task-dialog').dataset.acceptanceConsentClosed==='done'");
    assert.equal(savedAuthorization.action, "task-save"); assert.equal(savedAuthorization.target.threadId, "legacy-chat");
    assert.deepEqual(savedAuthorization.target.authorization, { confirmed: true, readAllLocalFiles: true, context: "c".repeat(64), writableRoots: [directory] });
    assert.equal(savedAuthorization.definition.environment, undefined);
    assert.ok(requests.filter(request => request.kind !== "action").every(request => request.method === "GET"));
    assert.equal(requests.filter(request => request.kind === "action").length, 1); assert.deepEqual(failures, []);
    return { allChatsDefault: true, emptyProjectExplained: true, explicitShowAll: true, pagination: true, retry: true, staleResponseDiscarded: true,
      legacyProjectChatsSelectable: true, displayAssociationDoesNotGrantPermissions: true, explicitConsentRequired: true, consentClearedOnPolicyChange: true,
      authorizationSaveOnly: true, catalogReadOnly: true };
  } finally {
    await evaluate("new Promise(resolve=>{const dialog=document.getElementById('task-dialog');if(!dialog.open)return resolve(true);dialog.addEventListener('close',()=>resolve(true),{once:true});dialog.close()})").catch(() => {});
    await call("Fetch.disable"); stop();
  }
}
