import { resolve } from "node:path";
import { DesktopBackend } from "../../dist/src/desktop/backend.js";

// Test-only parent: its exit must close IPC and ask the real backend to finalize safely.
const backend = new DesktopBackend(process.argv[2], { executable: process.execPath,
  entry: resolve("dist/src/desktop/backend-entry.js"), electron: false });
const connection = await backend.start();
process.send(connection);
process.once("disconnect", () => process.exit(0));
