import { cp, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { packager } from "@electron/packager";
import { root, runtimeFiles } from "./lib/runtime-files.mjs";

if (process.platform !== "win32" || process.arch !== "x64") throw new Error("The first desktop target is Windows x64; build on Windows x64.");
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--output-name" || !/^[a-zA-Z0-9_-]+$/.test(args[1]))) {
  throw new Error("Usage: package-desktop.mjs [--output-name generated-directory-name]");
}
const files = await runtimeFiles({ desktop: true });
const source = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const electron = JSON.parse(await readFile(join(root, "node_modules/electron/package.json"), "utf8"));
const outputName = args[1] ?? "desktop";
const output = resolve(root, ".release", outputName);
await mkdir(output, { recursive: true });
if (await realpath(output) !== join(await realpath(root), ".release", outputName)) throw new Error("Desktop output must remain inside the repository.");
await mkdir(join(root, ".tmp"), { recursive: true });
const stage = await mkdtemp(join(root, ".tmp/desktop-stage-"));
for (const path of files) {
  await mkdir(dirname(join(stage, path)), { recursive: true });
  await cp(join(root, path), join(stage, path));
}
await writeFile(join(stage, "package.json"), JSON.stringify({ name: source.name, version: source.version, private: true,
  description: source.description, type: "module", main: "dist/src/desktop/main.js" }, null, 2) + "\n");
// Stage contains only current runtime files, no dev dependencies or personal data. Do not overwrite a package in use.
const paths = await packager({ dir: stage, out: output, name: "CodexQuotaScheduler", executableName: "CodexQuotaScheduler",
  platform: "win32", arch: "x64", electronVersion: electron.version, asar: false, prune: false, overwrite: false,
  download: { cacheRoot: join(root, ".tmp/electron-cache") } });
if (!paths.length) throw new Error("No desktop package was produced. Move the existing generated package before rebuilding.");
console.log(JSON.stringify({ package: paths[0], executable: join(paths[0], "CodexQuotaScheduler.exe"), electron: electron.version }));
