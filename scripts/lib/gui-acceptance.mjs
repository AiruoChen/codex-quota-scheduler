import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Real DOM interaction in a disposable mock profile; no account or real submission. */
export async function guiAcceptance(page, directory) {
  const { evaluate, wait, call } = page;
  assert.equal(await evaluate("document.querySelectorAll('nav [data-view]').length"), 6);
  await evaluate("location.hash='#tasks'");
  await wait("!document.getElementById('tasks').hidden");
  await evaluate("document.getElementById('new-task').click()");
  await wait("document.getElementById('task-dialog').open");
  await evaluate(`(() => {
    const form=document.getElementById('task-form');
    for(const [key,value] of Object.entries({id:'gui-smoke',name:'GUI <b>验收</b>',projectDir:${JSON.stringify(directory)},prompt:'Synthetic GUI verification only.'})) form.elements.namedItem(key).value=value;
    form.requestSubmit();
  })()`);
  await wait("!document.getElementById('task-dialog').open && document.getElementById('task-rows').textContent.includes('gui-smoke')");
  assert.equal(await evaluate("document.querySelectorAll('#task-rows b').length"), 0, "Task names are rendered as text");
  await evaluate("[...document.querySelectorAll('#task-rows tr')].find(row=>row.textContent.includes('gui-smoke')).querySelector('button').click()");
  await wait("document.getElementById('task-dialog').open");
  await evaluate("document.getElementById('task-form').elements.namedItem('prompt').value='Synthetic revision two.';document.getElementById('task-form').requestSubmit()");
  await wait("!document.getElementById('task-dialog').open && [...document.querySelectorAll('#task-rows tr')].some(row=>row.textContent.includes('gui-smoke') && row.textContent.includes('v2'))");
  await evaluate("[...document.querySelectorAll('#task-rows tr')].find(row=>row.textContent.includes('gui-smoke')).querySelectorAll('button')[1].click()");
  await wait("document.getElementById('snapshot-dialog').open && document.getElementById('snapshot-body').textContent.includes('Synthetic revision two.')");
  await evaluate("document.getElementById('snapshot-confirm').click()");
  await wait("!document.getElementById('snapshot-dialog').open");
  await wait("fetch('/api/state').then(r=>r.json()).then(s=>s.scheduler.queue.some(q=>q.taskId==='gui-smoke' && q.revision===2))");
  await evaluate("location.hash='#queue'");
  await wait("!document.getElementById('queue').hidden && document.getElementById('queue-items').textContent.includes('gui-smoke')");
  assert.equal(await evaluate("document.querySelector('[data-action=resume]').disabled"), true);
  await evaluate("[...document.querySelectorAll('#queue-items .queue-item')].find(row=>row.textContent.includes('gui-smoke')).querySelector('button').click()");
  await wait("document.getElementById('run-dialog').open && document.getElementById('run-detail').textContent.includes('Synthetic revision two.')");
  await evaluate("document.getElementById('run-dialog').close();location.hash='#runs'");
  await wait("!document.getElementById('runs').hidden && document.getElementById('run-rows').textContent.includes('GUI <b>验收</b>')");
  await evaluate("location.hash='#recovery'"); await wait("!document.getElementById('recovery').hidden && !!document.getElementById('recovery-report').textContent");
  await evaluate("location.hash='#settings'"); await wait("!document.getElementById('settings').hidden && document.getElementById('active-config').textContent.includes('mock')");
  await evaluate("location.hash='#overview'"); await wait("!document.getElementById('overview').hidden && Number(document.getElementById('waiting-count').textContent)>=2");
  await evaluate("document.querySelector('[data-action=monitor-stop]').click()");
  await wait("document.getElementById('monitor-status').textContent==='监控已停止'");
  await evaluate("document.querySelector('[data-action=sample]').click()");
  await wait("!document.querySelector('[data-action=sample]').disabled && document.getElementById('freshness-status').textContent==='读数有效'");
  await call("Network.enable");
  await call("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await evaluate("document.getElementById('reload').click()");
  await wait("!document.getElementById('connection').hidden && document.getElementById('quota-availability').textContent.includes('未知')");
  assert.equal(await evaluate("document.querySelector('[data-action=sample]').disabled"), true);
  assert.equal(await evaluate("document.querySelectorAll('#quota-windows progress').length"), 0);
  await call("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await evaluate("document.getElementById('reload').click()");
  await wait("document.getElementById('connection').hidden && !document.querySelector('[data-action=sample]').disabled");
  await evaluate("document.querySelector('[data-action=monitor-start]').click()");
  await wait("document.getElementById('monitor-status').textContent==='持续监控中'");
  for (const [width, height, scale] of [[1200, 800, 1], [960, 640, 1.5], [960, 640, 2], [390, 844, 1]]) {
    await call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile: false });
    await evaluate("window.scrollTo(0,0)");
    assert.equal(await evaluate("document.documentElement.scrollWidth<=innerWidth"), true, `No horizontal page overflow at ${width}x${height}/${scale}`);
    const screenshot = await call("Page.captureScreenshot", { format: "png" });
    await writeFile(join(directory, `gui-${width}-${scale}.png`), Buffer.from(screenshot.data, "base64"));
  }
  await call("Emulation.clearDeviceMetricsOverride");
  return { sixRoutes: true, taskRevision: 2, immutableSnapshot: true, textEscaping: true, offlineUnknown: true, reconnect: true, responsiveLayouts: 4 };
}
