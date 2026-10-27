import assert from "node:assert/strict";

/** Concurrent writers are synthetic API calls in the owned smoke profile. */
export async function tasksQueueAcceptance(page, taskId) {
  const evaluate = source => page.evaluate(source.replaceAll("gui-smoke", taskId));
  const wait = source => page.wait(source.replaceAll("gui-smoke", taskId));
  await page.call("Page.bringToFront");
  assert.deepEqual(await evaluate("Object.keys(window.desktopProject)"), ["chooseDirectory"]);
  await evaluate("location.hash='#tasks'");
  await wait("!document.getElementById('tasks').hidden && document.getElementById('task-rows').textContent.includes('gui-smoke')");
  await evaluate("document.getElementById('task-search').value='no-match';document.getElementById('task-search').dispatchEvent(new Event('input'))");
  await wait("document.getElementById('task-rows').children.length===0");
  await evaluate("document.getElementById('task-search').value='gui-smoke';document.getElementById('task-search').dispatchEvent(new Event('input'))");
  await wait("document.getElementById('task-rows').children.length===1");
  await evaluate("document.querySelector('#task-rows button').click()");
  await wait("document.getElementById('task-dialog').open");
  const compete = `(async()=>{const csrf=(await(await fetch('/api/bootstrap')).json()).csrf;const task=await(await fetch('/api/task?id=gui-smoke')).json();const r=await fetch('/api/action',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({action:'task-save',definition:task,revision:task.revision,prompt:'Concurrent fixture revision '+(task.revision+1)})});if(!r.ok)throw new Error('Fixture writer failed');return r.json()})()`;
  await evaluate(compete);
  await evaluate("document.getElementById('task-form').elements.namedItem('prompt').value='Unsaved fixture draft';document.getElementById('task-form').requestSubmit()");
  await wait("document.getElementById('task-error').textContent.includes('TASK_CONFLICT')");
  assert.equal(await evaluate("document.getElementById('task-form').elements.namedItem('prompt').value"), "Unsaved fixture draft");
  await evaluate("document.getElementById('task-dialog').close()");
  await wait("document.querySelector('#task-rows tr').textContent.includes('v3')");
  await evaluate("document.querySelectorAll('#task-rows button')[1].click()");
  await wait("document.getElementById('snapshot-dialog').open && document.getElementById('snapshot-title').textContent.includes('v3')");
  await evaluate(compete);
  await evaluate("document.getElementById('snapshot-confirm').click()");
  await wait("document.getElementById('snapshot-error').textContent.includes('TASK_CONFLICT')");
  assert.equal(await evaluate("fetch('/api/state').then(r=>r.json()).then(s=>s.scheduler.queue.filter(q=>q.taskId==='gui-smoke').length)"), 1);
  await evaluate("document.getElementById('snapshot-dialog').close()");
  await wait("document.querySelector('#task-rows tr').textContent.includes('v4')");
  for (let index=0;index<2;index++) {
    await evaluate("document.querySelectorAll('#task-rows button')[1].click()");
    await wait("document.getElementById('snapshot-dialog').open");
    await evaluate("document.getElementById('snapshot-confirm').click()");
    await wait("!document.getElementById('snapshot-dialog').open");
  }
  const entries = await evaluate("fetch('/api/state').then(r=>r.json()).then(s=>s.scheduler.queue.filter(q=>q.taskId==='gui-smoke'))");
  assert.deepEqual(entries.map(q=>q.revision), [2,4]);
  assert.equal(await evaluate(`fetch('/api/run?id=${entries[0].runId}').then(r=>r.json()).then(d=>d.run.promptSnapshot)`), "Synthetic revision two.");
  await evaluate("location.hash='#queue';document.getElementById('queue-search').value='gui-smoke';document.getElementById('queue-search').dispatchEvent(new Event('input'))");
  await wait("document.querySelectorAll('#queue-items .queue-item').length===2");
  assert.ok(await evaluate("document.getElementById('queue-items').textContent.includes('入队序号')"));
  await evaluate("document.getElementById('queue-search').value='';document.getElementById('queue-search').dispatchEvent(new Event('input'));location.hash='#overview'");
  return { filtering:true, conflictDraftPreserved:true, stalePreviewRejected:true, duplicateSnapshotDeduplicated:true, nativeBridgeRestricted:true };
}
