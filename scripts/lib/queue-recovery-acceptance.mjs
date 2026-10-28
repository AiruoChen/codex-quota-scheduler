import assert from "node:assert/strict";
import { join, resolve, sep } from "node:path";
import { loadConfig } from "../../dist/src/config/load.js";
import { SqliteStore } from "../../dist/src/storage/sqlite-store.js";
import { SqliteSchedulerRepository } from "../../dist/src/storage/scheduler-repository.js";
import { quotaStreamKey } from "../../dist/src/monitor/context.js";

/** All mutations target this harness's owned mock profile. No real task is executed. */
export async function queueRecoveryAcceptance(page, configPath, directory, checkpoint) {
  const config = await loadConfig(configPath); assert.equal(config.provider, "mock");
  assert.ok(resolve(config.storage.databasePath).startsWith(resolve(directory) + sep));
  const store = new SqliteStore(config.storage.databasePath); let run;
  try {
    await store.tasks.create({ id: "queue-removal-fixture", name: "Queue removal fixture", enabled: true, priority: 1, projectDir: directory,
      promptFile: join(directory, "unused.md"), session: { mode: "new" } }, "PRIVATE_REMOVAL_FIXTURE");
    const queue = new SqliteSchedulerRepository(store.database, quotaStreamKey(config), "available", config, { now: () => new Date() });
    run = queue.enqueue("queue-removal-fixture"); await store.runs.update(run.id, { status: "needs_attention", error: "CODEX_AUTHORIZATION_MISMATCH: fixture" }, "queued");
  } finally { store.close(); }
  checkpoint("queue-attention-detail");
  await page.evaluate("location.hash='#queue';document.getElementById('queue-search').value='queue-removal-fixture';document.getElementById('queue-search').dispatchEvent(new Event('input'))");
  await page.wait("document.querySelectorAll('#queue-items .queue-item').length===1&&document.getElementById('queue-items').textContent.includes('移除并解除阻塞')");
  await page.evaluate("[...document.querySelectorAll('#queue-items button')].find(b=>b.textContent==='查看快照').click()");
  await page.wait("document.getElementById('run-dialog').open&&document.getElementById('run-detail').textContent.includes('缺少准确')");
  assert.equal(await page.evaluate("[...document.querySelectorAll('#run-detail button')].find(b=>b.textContent==='无法应用远端结果').disabled"), true);
  checkpoint("queue-detailed-diagnostics");
  await page.evaluate("document.querySelector('[data-run-diagnostics]').open=true;[...document.querySelectorAll('[data-run-diagnostics] button')].find(b=>b.textContent==='查看／刷新详细诊断').click()");
  await page.wait("document.querySelector('[data-run-diagnostics] pre').textContent.includes('timelineAvailable')");
  const report = JSON.parse(await page.evaluate("document.querySelector('[data-run-diagnostics] pre').textContent"));
  assert.equal(report.runId, run.id); assert.equal(report.canReconcile, false); assert.equal(report.evidence.submissionStarted, false);
  assert.ok(!JSON.stringify(report).includes("PRIVATE_REMOVAL_FIXTURE")); assert.ok(!JSON.stringify(report).includes(directory));
  checkpoint("queue-diagnostic-download");
  await page.evaluate("(()=>{window.__diagnosticNativeClick=HTMLAnchorElement.prototype.click;HTMLAnchorElement.prototype.click=function(){window.__diagnosticDownload=this.download};[...document.querySelectorAll('[data-run-diagnostics] button')].find(b=>b.textContent==='下载诊断 JSON').click()})()");
  try { await page.wait("window.__diagnosticDownload?.endsWith('-diagnostics.json')"); }
  finally { await page.evaluate("HTMLAnchorElement.prototype.click=window.__diagnosticNativeClick;delete window.__diagnosticNativeClick"); }
  checkpoint("queue-attention-remove");
  await page.evaluate("document.getElementById('run-dialog').close();(()=>{const original=window.confirm;window.confirm=text=>{window.__removalConfirmation=text;return true};[...document.querySelectorAll('#queue-items button')].find(b=>b.textContent==='移除并解除阻塞').click();window.confirm=original})()");
  await page.wait("document.querySelectorAll('#queue-items .queue-item').length===0");
  assert.equal(await page.evaluate("window.__removalConfirmation.includes('未知结果与历史保留')"), true);
  const state = await page.evaluate("fetch('/api/state').then(r=>r.json())");
  assert.equal(state.scheduler.attention.includes(run.id), false); assert.equal(state.scheduler.paused, true);
  const verify = new SqliteStore(config.storage.databasePath);
  try { assert.equal((await verify.runs.get(run.id)).status, "needs_attention"); assert.equal((await verify.runs.get(run.id)).promptSnapshot, "PRIVATE_REMOVAL_FIXTURE"); await verify.check(); }
  finally { verify.close(); }
  await page.evaluate("document.getElementById('queue-search').value='';document.getElementById('queue-search').dispatchEvent(new Event('input'));location.hash='#overview'");
  return { attentionRemoval: true, historyPreserved: true, dispatchStaysPaused: true, incompleteRecoveryDisabled: true, detailedDiagnosticView: true, diagnosticDownload: true };
}
