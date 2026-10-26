import { writeFile } from "node:fs/promises";
import { join } from "node:path";

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
