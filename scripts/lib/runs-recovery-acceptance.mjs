import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Renderer fixtures exercise presentation only; backend records and remote protocol are untouched. */
export async function runsRecoveryAcceptance(page, directory, taskId) {
  const { call } = page;
  const evaluate = source => page.evaluate(source.replaceAll("gui-smoke", taskId));
  const wait = source => page.wait(source.replaceAll("gui-smoke", taskId));
  await call("Page.bringToFront");
  const state = await evaluate("fetch('/api/state').then(r=>r.json())");
  const entries = state.scheduler.queue.filter(q=>q.taskId===taskId);
  const first = entries.find(q=>q.revision===2), second = entries.find(q=>q.revision===4);
  assert.ok(first && second);
  const actual = await evaluate(`fetch('/api/run?id=${first.runId}').then(r=>r.json())`);
  const fixture = { ...actual, run: { ...actual.run, status: "running", threadId: "fixture-thread", turnId: "fixture-turn", output: Array.from({length:120},(_,i)=>`Fixture output line ${i}`).join("\n") }, origin: { account:"f***@example.invalid",cliVersion:"fixture-version" } };
  let held, mode = "respond";
  const errors=[];
  async function fulfill(requestId, value) {
    await call("Fetch.fulfillRequest", { requestId,responseCode:200,responseHeaders:[{name:"Content-Type",value:"application/json"}],body:Buffer.from(JSON.stringify(value)).toString("base64") });
  }
  const stop = page.on("Fetch.requestPaused", event => {
    if(mode==="hold") { held=event.requestId; return; }
    void fulfill(event.requestId,fixture).catch(error=>errors.push(error));
  });
  await call("Fetch.enable", {patterns:[{urlPattern:`*/api/run?id=${first.runId}`,requestStage:"Request"}]});
  try {
    await evaluate("location.hash='#runs';document.getElementById('runs-search').value='gui-smoke';document.getElementById('runs-search').dispatchEvent(new Event('input'))");
    await wait("document.querySelectorAll('#run-rows tr').length===2");
    await evaluate("[...document.querySelectorAll('#run-rows tr')].find(row=>row.textContent.includes('v2')).querySelector('button').click()");
    await wait("document.getElementById('run-output')?.textContent.includes('Fixture output line 119')");
    await evaluate("(()=>{const output=document.getElementById('run-output'),range=document.createRange();range.setStart(output.firstChild,0);range.setEnd(output.firstChild,15);const s=getSelection();s.removeAllRanges();s.addRange(range);output.scrollTop=100;})()");
    fixture.run.output += "\nNEW FIXTURE OUTPUT";
    await evaluate("document.getElementById('run-refresh').click()");
    await wait("document.getElementById('run-update-hint').textContent.includes('有新状态')");
    assert.equal(await evaluate("document.getElementById('run-output').textContent.includes('NEW FIXTURE OUTPUT')"),false);
    assert.equal(await evaluate("getSelection().toString()"),"Fixture output ");
    await evaluate("getSelection().removeAllRanges()");
    await wait("document.getElementById('run-output').textContent.includes('NEW FIXTURE OUTPUT')");
    assert.equal(await evaluate("document.getElementById('run-output').scrollTop"),100);
    // Model the foreground user gesture without depending on the Windows runner's active desktop.
    await call("Emulation.setFocusEmulationEnabled", { enabled: true });
    try {
      await call("Runtime.evaluate",{expression:"[...document.querySelectorAll('#run-detail button')].find(b=>b.textContent==='复制输出').click()",userGesture:true});
      await wait("document.getElementById('notice').textContent==='输出已复制。'");
    } finally { await call("Emulation.setFocusEmulationEnabled", { enabled: false }); }
    fixture.cancelRequested=true;await evaluate("document.getElementById('run-refresh').click()");
    await wait("document.getElementById('run-detail').textContent.includes('尚未确认取消')");
    assert.equal(await evaluate("[...document.querySelectorAll('#run-detail button')].find(b=>b.textContent==='等待取消确认').disabled"),true);
    for(const width of [960,390]) {
      await call("Emulation.setDeviceMetricsOverride",{width,height:640,deviceScaleFactor:1,mobile:false});
      assert.equal(await evaluate("document.getElementById('run-dialog').scrollWidth<=document.getElementById('run-dialog').clientWidth"),true,`Detail fits ${width}px`);
    }
    const detailImage=await call("Page.captureScreenshot",{format:"png"});await writeFile(join(directory,"run-detail.png"),Buffer.from(detailImage.data,"base64"));
    await call("Emulation.clearDeviceMetricsOverride");
    mode="hold";await evaluate("document.getElementById('run-refresh').click()");
    for(let attempt=0;attempt<50&&!held;attempt++) await delay(50);
    assert.ok(held);
    await evaluate("document.getElementById('run-dialog').close()");
    await wait("!document.getElementById('run-dialog').open && document.getElementById('run-detail').textContent.includes('正在读取')");
    await evaluate("[...document.querySelectorAll('#run-rows tr')].find(row=>row.textContent.includes('v4')).querySelector('button').click()");
    await wait(`document.getElementById('run-detail').textContent.includes('${second.runId}')`);
    fixture.run.output="OLD RECORD RESPONSE";await fulfill(held,fixture);await delay(100);
    assert.equal(await evaluate("document.getElementById('run-output').textContent.includes('OLD RECORD RESPONSE')"),false);
    await evaluate("document.getElementById('run-dialog').close()");
  } finally { await call("Fetch.disable");stop(); }
  assert.deepEqual(errors,[]);
  const recoveryState={...state,recovery:{...state.recovery,issues:[{code:"execution_owner_unknown",ownerPid:987654,runId:first.runId}],owners:[{kind:"execution",pid:987654,state:"unknown",runId:first.runId}]},scheduler:{...state.scheduler,attention:[first.runId]},jobs:[...state.jobs,{id:99999,kind:"inspect",state:"failed",runId:first.runId,code:"RECOVERY_READ_FAILED",detail:null}]};
  const pending={...fixture.run,status:"needs_attention",name:fixture.run.taskSnapshot.name,projectDir:fixture.run.taskSnapshot.projectDir};
  delete pending.output;delete pending.promptSnapshot;delete pending.taskSnapshot;
  const stopRecovery=page.on("Fetch.requestPaused",event=>{void fulfill(event.requestId,event.request.url.includes('/api/state')?{...recoveryState,now:new Date().toISOString()}:{items:[pending],total:1,offset:0,limit:25}).catch(error=>errors.push(error));});
  await call("Fetch.enable",{patterns:[{urlPattern:"*/api/state",requestStage:"Request"},{urlPattern:"*/api/runs/page?status=needs_attention*",requestStage:"Request"}]});
  try {
    await evaluate("location.hash='#recovery';document.getElementById('recovery-refresh').click()");
    await wait("document.getElementById('recovery-report').textContent.includes('无法确认') && document.querySelectorAll('#attention .attention-card').length===1");
    assert.equal(await evaluate("[...document.querySelectorAll('#attention button')].find(b=>b.textContent==='只读核对').disabled"),true);
    assert.ok(await evaluate("document.getElementById('recovery-results').textContent.includes('尚未确认')"));
    const screenshot=await call("Page.captureScreenshot",{format:"png"});await writeFile(join(directory,"recovery.png"),Buffer.from(screenshot.data,"base64"));
  } finally {await call("Fetch.disable");stopRecovery();}
  await evaluate("document.getElementById('recovery-refresh').click()");
  await wait("document.getElementById('recovery-report').textContent.includes('未发现') && document.querySelectorAll('#attention .attention-card').length===0");
  await evaluate("location.hash='#overview'");
  assert.deepEqual(errors,[]);
  return {filters:true,selectionPreserved:true,scrollPreserved:true,copyOutput:true,staleDetailIgnored:true,unknownOwnerGuidance:true,mockRecoveryBlocked:true};
}
