import type { ProcessInspector } from "../domain/recovery.js";

/** EPERM and unknown errors cannot prove that a process has exited. PID reuse stays conservative. */
export const localProcesses: ProcessInspector = {
  inspect(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return "unknown";
    try { process.kill(pid, 0); return "alive"; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unknown"; }
  },
};
