import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { SqliteStore } from "../../dist/src/storage/sqlite-store.js";
import { readInstance } from "../../dist/src/runtime/instance.js";
import { closeWindow } from "./close-window.mjs";

/** Model fixtures stay in the owned mock database. No task is submitted to Codex. */
export async function trayAcceptance(page, control, profile, configPath, directory, processId, checkpoint = () => {}) {
  checkpoint("tray-ready");
  await control.wait("window.desktopLifecycle.read().then(v=>v.desktop.trayAvailable)");
  const before = await readInstance(configPath);
  const statePath = join(profile, "desktop-state.json");
  for (let attempt = 0; attempt < 60; attempt++) {
    const state = JSON.parse(await readFile(statePath, "utf8"));
    if (state.checkpoint.scope) break;
    await delay(100);
  }
  await control.evaluate("window.desktopLifecycle.command('show')");
  await page.wait("document.visibilityState==='visible' && document.hasFocus()");
  checkpoint("tray-native-close");
  await closeWindow(page, processId);
  checkpoint("tray-close-notice");
  await control.wait("window.desktopLifecycle.read().then(v=>v.desktop.closeNotice && v.phase==='running')");
  await page.wait("document.visibilityState==='hidden'");
  checkpoint("tray-hide");
  await control.evaluate("window.desktopLifecycle.command('hide')");
  await control.wait("window.desktopLifecycle.read().then(v=>v.desktop.hidden)");
  assert.equal((await readInstance(configPath)).pid, before.pid);
  checkpoint("tray-pause");
  await control.evaluate("window.desktopLifecycle.command('pause')");
  checkpoint("tray-preferences");
  await control.evaluate("window.desktopLifecycle.command('notifications-toggle')");
  await control.evaluate("window.desktopLifecycle.command('quota-notifications-toggle')");
  const preferences = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(preferences.settings.enabled, false);
  assert.equal(preferences.settings.quotaReset, true);
  assert.equal(preferences.settings.closeExplained, true);
  checkpoint("tray-notification-fixture");
  const store = new SqliteStore(join(profile, "data/state.sqlite"));
  let run;
  try {
    await store.tasks.create({ id: "tray-fixture", name: "PRIVATE_SYNTHETIC_TRAY_NAME", enabled: true,
      projectDir: directory, promptFile: join(directory, "unused.md"), priority: 1, session: { mode: "new" } }, "PRIVATE_SYNTHETIC_TRAY_BODY");
    run = await store.runs.create("tray-fixture");
    await store.runs.update(run.id, { status: "running" }, "queued");
    store.execution.event(run.id, "execution_finished", { status: "succeeded" });
    await store.runs.update(run.id, { status: "succeeded", output: "PRIVATE_SYNTHETIC_TRAY_OUTPUT" }, "running");
  } finally { store.close(); }
  checkpoint("tray-notification-delivery");
  await control.wait("window.desktopLifecycle.read().then(v=>v.desktop.notices.some(n=>n.title.includes('任务已完成')))");
  const view = await control.evaluate("window.desktopLifecycle.read()");
  const notice = view.desktop.notices.find((item) => item.title.includes("任务已完成"));
  assert.ok(notice.title.startsWith("模拟环境"));
  assert.equal(notice.delivery, "disabled");
  assert.ok(!JSON.stringify(view.desktop.notices).includes("PRIVATE_SYNTHETIC"));
  assert.ok(!JSON.stringify(view.desktop.notices).includes(directory));
  checkpoint("tray-notification-target");
  await control.evaluate(`window.desktopLifecycle.openNotice(${JSON.stringify(notice.id)})`);
  await page.wait(`document.getElementById('run-dialog')?.open && document.getElementById('run-detail').textContent.includes('${run.id}')`);
  await page.evaluate("document.getElementById('run-dialog').close();location.hash='#overview'");
  checkpoint("tray-notification-dedupe");
  await control.evaluate("window.desktopLifecycle.command('hide')");
  assert.equal(await control.evaluate("window.desktopLifecycle.read().then(v=>v.desktop.closeNotice)"), false);
  await delay(3200);
  assert.equal(await control.evaluate("window.desktopLifecycle.read().then(v=>v.desktop.notices.length)"), view.desktop.notices.length);
  checkpoint("tray-notification-history");
  await control.evaluate("window.desktopLifecycle.command('status')");
  await control.evaluate("document.getElementById('notification-history').scrollIntoView()");
  const screenshot = await control.call("Page.captureScreenshot", { format: "png" });
  await writeFile(join(directory, "tray-notifications.png"), Buffer.from(screenshot.data, "base64"));
  await control.evaluate("window.desktopLifecycle.command('show')");
  await page.wait("document.visibilityState==='visible'");
  return { closeHides: true, firstCloseExplained: true, backendPreserved: true, preferencesSaved: true,
    hiddenEventsRecorded: true, disabledNativeRetainsHistory: true, privateTextExcluded: true, exactNotificationTarget: true };
}
