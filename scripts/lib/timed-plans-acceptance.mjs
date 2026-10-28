import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Real renderer, disposable mock profile. This suite never enables a real plan or submits instructions. */
export async function timedPlansAcceptance(page, taskId, directory, checkpoint = () => {}) {
  checkpoint("timed-plans-draft");
  await page.evaluate("location.hash='#schedules'");
  await page.wait("!document.getElementById('schedules').hidden && !!document.getElementById('schedule-status').textContent");
  assert.equal(await page.evaluate("document.getElementById('schedule-status').textContent.includes('当前不会执行')"), true);
  await page.evaluate("document.getElementById('new-schedule').click()");
  await page.wait("document.getElementById('schedule-dialog').open");
  await page.evaluate(`(()=>{ const f=document.querySelector('#schedule-dialog form'); f.elements.namedItem('name').value='Timed <b>fixture</b>'; f.elements.namedItem('taskId').value=${JSON.stringify(taskId)}; f.elements.namedItem('taskId').dispatchEvent(new Event('change',{bubbles:true})); f.elements.namedItem('zone').value='UTC'; f.elements.namedItem('date').value=new Date(Date.now()+86400000).toISOString().slice(0,10); f.requestSubmit(); })()`);
  await page.wait("!document.getElementById('schedule-dialog').open && document.getElementById('schedule-items').textContent.includes('Timed <b>fixture</b>')");
  assert.equal(await page.evaluate("document.querySelectorAll('#schedule-items b').length"), 0);
  const plan = await page.evaluate("fetch('/api/timed-plans').then(r=>r.json()).then(p=>p.plans.find(p=>p.input.name==='Timed <b>fixture</b>'))");
  assert.equal(plan.state, "draft"); assert.equal(plan.occurrences.length, 0); assert.equal(plan.input.catchUp, false);
  const listImage = await page.call("Page.captureScreenshot", { format: "png" });
  await writeFile(join(directory, "timed-plans-list.png"), Buffer.from(listImage.data, "base64"));
  checkpoint("timed-plans-preview-no-execution");
  await page.evaluate("[...document.querySelectorAll('#schedule-items button')].find(b=>b.textContent==='预览并启用').click()");
  await page.wait("[...document.querySelectorAll('dialog[open]')].some(d=>d.textContent.includes('确认启用计划'))");
  assert.equal(await page.evaluate("[...document.querySelectorAll('dialog[open] button')].find(b=>b.textContent==='确认启用计划').disabled"), true);
  assert.equal(await page.evaluate("[...document.querySelectorAll('dialog[open] input[type=checkbox]')].some(n=>n.checked)"), false);
  await page.evaluate("[...document.querySelectorAll('dialog[open]')].forEach(d=>d.close())");
  checkpoint("timed-plans-editor-draft-retained");
  await page.evaluate("[...document.querySelectorAll('#schedule-items button')].find(b=>b.textContent==='编辑').click()");
  await page.wait("document.getElementById('schedule-dialog').open");
  await page.evaluate("document.querySelector('#schedule-dialog [name=name]').value='Unsaved schedule fixture'");
  await page.evaluate("document.getElementById('reload').click()");
  await page.wait("!document.getElementById('reload').hasAttribute('aria-busy')");
  assert.equal(await page.evaluate("document.querySelector('#schedule-dialog [name=name]').value"), "Unsaved schedule fixture");
  const editorImage = await page.call("Page.captureScreenshot", { format: "png" });
  await writeFile(join(directory, "timed-plan-editor.png"), Buffer.from(editorImage.data, "base64"));
  await page.evaluate("document.getElementById('schedule-dialog').close();location.hash='#overview'");
  return { mockOnly: true, draftNoRun: true, explicitConsent: true, textEscaping: true, draftRetained: true };
}
