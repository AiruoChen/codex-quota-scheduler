import { cp, lstat, mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { root, runtimeFiles } from "./lib/runtime-files.mjs";

const output = resolve(root, ".release/codex-quota-scheduler");
// Rebuild only the known generated directory, with an explicit containment check.
if (!output.startsWith(resolve(root, ".release") + sep)) throw new Error("Invalid package path");
await mkdir(resolve(root, ".release"), { recursive: true });
// A symlink/junction must not redirect cleanup outside the repository.
const releaseRoot = await realpath(resolve(root, ".release"));
if (releaseRoot !== join(await realpath(root), ".release")) throw new Error("Package parent must not be a symlink");
const outputInfo = await lstat(output).catch((error) => {
  if (error.code === "ENOENT") return null;
  throw error;
});
if (outputInfo?.isSymbolicLink()) throw new Error("Package output must not be a symlink");

// Derive emitted files from current sources: tsc intentionally leaves old output behind.
const files = await runtimeFiles();
const existing = await readdir(output, { recursive: true }).catch((error) => {
  if (error.code === "ENOENT") return [];
  throw error;
});
if (existing.some((path) => /(^|[\\/])(\.runtime|\.local|auth\.json|\.env)([\\/]|$)|(^|[\\/])local\.json|\.sqlite(?:-|$)|\.log(?:\.|$)/.test(path))) {
  throw new Error("Package directory contains local configuration or runtime data. Back it up and move it before rebuilding.");
}
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const path of files) {
  await mkdir(dirname(join(output, path)), { recursive: true });
  await cp(join(root, path), join(output, path));
}
const source = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
await writeFile(join(output, "package.json"), JSON.stringify({ name: source.name, version: source.version, private: true, type: "module", engines: source.engines,
  scripts: { start: "node --experimental-sqlite dist/src/cli.js", ui: "node --experimental-sqlite dist/src/cli.js ui" } }, null, 2) + "\n");
console.log("Portable directory: .release/codex-quota-scheduler (Node.js 22.12+; no npm install required)");
