import { writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Public CI output contains fixed labels and scalar assertion results, never raw errors. */
export function smokeFailureSummary(checkpoint, error, diagnostic = null) {
  const message = error instanceof Error ? error.message : "";
  const reason = message.startsWith("Desktop UI did not become ready:") ? "UI_NOT_READY"
    : message.startsWith("Desktop debugger timeout:") ? "DEBUGGER_TIMEOUT"
    : message.startsWith("Native config picker automation failed:") ? "NATIVE_PICKER_FAILED"
    : error?.code === "ERR_ASSERTION" ? "ASSERTION_FAILED" : "SMOKE_CHECK_FAILED";
  const summary = { checkpoint, reason,
    visibility: diagnostic?.management?.visibility === "visible" ? "visible" : diagnostic?.management?.visibility === "hidden" ? "hidden" : "unknown",
    focused: diagnostic?.management?.focused === true };
  for (const key of ["actual", "expected"]) {
    if (typeof error?.[key] === "boolean" || typeof error?.[key] === "number" && Number.isFinite(error[key])) summary[key] = error[key];
  }
  return summary;
}

/** Only synthetic smoke-test state is exported. Never copy profiles, logs, prompts or instance records. */
export async function desktopDiagnostics(directory, { checkpoint, error, page, control }) {
  const [management, lifecycle] = await Promise.allSettled([
    page?.evaluate("({readyState:document.readyState,visibility:document.visibilityState,focused:document.hasFocus(),origin:location.origin,source:document.getElementById('source')?.textContent??null})"),
    control?.evaluate("window.desktopLifecycle?.read().then(v=>({phase:v.phase,code:v.code,mode:v.mode,intent:v.intent,owned:v.connection?.owned??null,activeOperations:v.activity?.activeOperations??null}))"),
  ]);
  const result = { checkpoint, error: error instanceof Error ? error.message : "Smoke check failed",
    management: management.status === "fulfilled" ? management.value ?? null : null,
    lifecycle: lifecycle.status === "fulfilled" ? lifecycle.value ?? null : null,
    scriptErrors: [...(page?.errors ?? []), ...(control?.errors ?? [])] };
  await writeFile(join(directory, "diagnostics.json"), JSON.stringify(result, null, 2) + "\n");
  return result;
}
