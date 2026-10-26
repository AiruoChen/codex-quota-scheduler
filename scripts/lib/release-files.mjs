import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { root, runtimeFiles } from "./runtime-files.mjs";

export const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const privatePayloadFile = (path) => /(?:^|\/)(?:auth\.json|desktop-state\.json|desktop-profile\.json|\.runtime|\.codex|\.git|node_modules|tests)(?:\/|$)|\.sqlite(?:-|$)|(?:^|\/)local\.json$/i.test(path);
export async function fileDigest(path) { return digest(await readFile(path)); }
export function sourceIdentity() {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true }).trim();
  const changed = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=normal"], { cwd: root, encoding: "utf8", windowsHide: true }).trim();
  return { commit, clean: changed === "" };
}
export function localPath(value) {
  if (typeof value !== "string" || !value || /[\x00-\x1f\x7f]/.test(value) || value.includes("\\") || isAbsolute(value)
    || value.split("/").some((item) => !item || item === "." || item === "..") || value.includes(":")) throw new Error("RELEASE_PATH_INVALID");
  return value;
}
export async function filesIn(directory) {
  const files = [];
  async function walk(folder) {
    for (const name of await readdir(folder)) {
      const path = join(folder, name), item = await lstat(path);
      if (item.isSymbolicLink()) throw new Error("RELEASE_SYMLINK_REJECTED");
      if (item.isDirectory()) await walk(path);
      else if (item.isFile()) files.push(relative(directory, path).split(sep).join("/"));
      else throw new Error("RELEASE_FILE_INVALID");
    }
  }
  if ((await lstat(directory)).isSymbolicLink()) throw new Error("RELEASE_SYMLINK_REJECTED");
  await walk(directory); return files.sort();
}
export async function generatedDirectory(path, fresh = false) {
  const releaseRoot = join(root, ".release"), target = resolve(root, path);
  const child = relative(releaseRoot, target);
  if (!child || isAbsolute(child) || child === ".." || child.startsWith(".." + sep)) throw new Error("RELEASE_OUTPUT_INVALID");
  const canonicalRoot = await realpath(root);
  let current = releaseRoot;
  for (const component of ["", ...child.split(sep).slice(0, -1)]) {
    if (component) current = join(current, component);
    try { await mkdir(current); } catch (error) { if (error?.code !== "EEXIST") throw error; }
    if ((await lstat(current)).isSymbolicLink() || !(await lstat(current)).isDirectory()) throw new Error("RELEASE_OUTPUT_INVALID");
    const canonical = await realpath(current);
    if (relative(canonicalRoot, canonical).split(sep)[0] !== ".release") throw new Error("RELEASE_OUTPUT_INVALID");
  }
  try { await mkdir(target); } catch (error) { if (fresh || error?.code !== "EEXIST") throw error; }
  if ((await lstat(target)).isSymbolicLink() || !(await lstat(target)).isDirectory()) throw new Error("RELEASE_OUTPUT_INVALID");
  return target;
}
export async function jsonFile(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + ".tmp";
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600); await handle.writeFile(JSON.stringify(value, null, 2) + "\n"); await handle.sync(); await handle.close(); handle = null;
    await rename(temporary, path);
  } finally { await handle?.close(); await unlink(temporary).catch(() => {}); }
}
export async function inspectInstaller(directory) {
  await filesIn(directory);
  const value = JSON.parse(await readFile(join(directory, "release.json"), "utf8"));
  if (!value || typeof value !== "object" || !/^\d+\.\d+\.\d+$/.test(value.version) || value.product !== "CodexQuotaScheduler" || value.platform !== "win32-x64"
    || value.file !== `CodexQuotaScheduler-${value.version}-win-x64-setup.exe` || !/^[a-f0-9]{64}$/.test(value.sha256)
    || !value.files || typeof value.files !== "object" || Array.isArray(value.files)
    || typeof value.unsigned !== "boolean" || Object.keys(value.files).length > 1000) throw new Error("RELEASE_MANIFEST_INVALID");
  for (const name of ["CodexQuotaScheduler.exe", "maintenance-guard.exe", "resources/app/package.json", "resources/app/dist/src/desktop/bootstrap.js"])
    if (!Object.hasOwn(value.files, name)) throw new Error("RELEASE_MANIFEST_INVALID");
  if (await fileDigest(join(directory, value.file)) !== value.sha256) throw new Error("RELEASE_INSTALLER_HASH_MISMATCH");
  const checksum = (await readFile(join(directory, value.file + ".sha256"), "utf8")).trim();
  if (checksum !== `${value.sha256}  ${value.file}`) throw new Error("RELEASE_CHECKSUM_INVALID");
  for (const [path, sha] of Object.entries(value.files)) {
    localPath(path);
    if (privatePayloadFile(path)) throw new Error("RELEASE_PRIVATE_FILE");
    if (!/^[a-f0-9]{64}$/.test(sha)) throw new Error("RELEASE_MANIFEST_INVALID");
  }
  return { version: value.version, file: value.file, sha256: value.sha256, files: value.files, unsigned: value.unsigned };
}
export async function inspectPayload(directory) {
  const app = join(directory, "resources/app");
  const expected = new Set((await runtimeFiles({ desktop: true })).map((path) => path.split(sep).join("/")));
  expected.add("package.json");
  const actual = await filesIn(app);
  if (actual.length !== expected.size || actual.some((path) => !expected.has(path))) throw new Error("RELEASE_PAYLOAD_WHITELIST");
  for (const path of actual) {
    const bytes = await readFile(join(app, path)), text = bytes.toString("utf8");
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{30,}|sk-[A-Za-z0-9]{32,}/.test(text)) throw new Error("RELEASE_PRIVATE_CONTENT");
    if (path.endsWith(".map")) {
      const map = JSON.parse(text);
      if (map.sourceRoot || !Array.isArray(map.sources) || map.sources.some((source) => isAbsolute(source) || /^[A-Za-z]:/.test(source))) throw new Error("RELEASE_PRIVATE_PATH");
    }
  }
  const all = await filesIn(directory);
  if (all.some(privatePayloadFile)) throw new Error("RELEASE_PRIVATE_FILE");
  return { files: all.length, appFiles: actual.length };
}
export async function verifyPayloadHashes(directory, files) {
  const actual = await filesIn(directory), expected = Object.keys(files).filter((name) => name !== "maintenance-guard.exe").sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("RELEASE_PAYLOAD_CHANGED");
  for (const name of actual) if (await fileDigest(join(directory, name)) !== files[name]) throw new Error("RELEASE_PAYLOAD_CHANGED");
}
