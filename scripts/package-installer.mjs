import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, realpath, writeFile, stat } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { root } from "./lib/runtime-files.mjs";
import { installerFiles, nsisCompiler, nsisRelease } from "./lib/nsis-tool.mjs";

if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Installer builds require Windows x64");
const args = process.argv.slice(2), options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!["--package", "--output-name", "--test-id"].includes(args[i]) || !args[i + 1] || options[args[i]]) throw new Error("Invalid installer argument");
  options[args[i]] = args[i + 1];
}
const outputName = options["--output-name"] ?? "installer";
if (!/^[a-zA-Z0-9_-]+$/.test(outputName) || options["--test-id"] && !/^[a-f0-9-]{36}$/.test(options["--test-id"])) throw new Error("Invalid output/test identity");
const input = resolve(root, options["--package"] ?? ".release/desktop/CodexQuotaScheduler-win32-x64");
if (!(await realpath(input)).startsWith(join(await realpath(root), ".release") + sep)) throw new Error("Installer inputs must remain inside generated releases");
const source = JSON.parse(await readFile(join(input, "resources/app/package.json"), "utf8"));
if (!/^\d+\.\d+\.\d+$/.test(source.version)) throw new Error("Installer needs a stable semantic version");
const output = resolve(root, ".release", outputName);
await mkdir(output, { recursive: true });
if (await realpath(output) !== join(await realpath(root), ".release", outputName)) throw new Error("Installer output redirected");
const setup = join(output, `CodexQuotaScheduler-${source.version}-win-x64${options["--test-id"] ? "-acceptance" : ""}-setup.exe`);
try { await stat(setup); throw new Error("Installer already exists; choose a new output directory"); }
catch (error) { if (error.code !== "ENOENT") throw error; }
const compiler = await nsisCompiler();
const stage = join(root, ".tmp", `installer-${randomUUID()}`);
await mkdir(stage, { recursive: true });
const payload = join(stage, "app"); await cp(input, payload, { recursive: true });
const compile = (script, defines) => execFileSync(compiler, ["/INPUTCHARSET", "UTF8", "/V2", ...Object.entries(defines).map(([key, value]) => `/D${key}=${value}`), join(root, "installer", script)],
  { windowsHide: true, stdio: "inherit", env: { ...process.env, NSISDIR: dirname(compiler) } });
compile("maintenance-guard.nsi", { OUTPUT: join(payload, "maintenance-guard.exe") });
const files = await installerFiles(payload);
if (files.some((path) => /(?:^|\/)(?:auth\.json|desktop-state\.json|desktop-profile\.json|\.runtime|\.codex|node_modules)(?:\/|$)|\.sqlite(?:-|$)|(?:^|\/)local\.json$/.test(path))) throw new Error("Private data in installer payload");
const quote = (value) => value.replaceAll("$", "$$").replaceAll('"', '$\\"');
const install = [], uninstall = [], directories = new Set();
let current = "";
for (const path of files) {
  const folder = dirname(path).replaceAll("/", "\\");
  if (folder !== current) { install.push(`SetOutPath "$INSTDIR${folder === "." ? "" : "\\" + quote(folder)}"`); current = folder; }
  install.push(`File "${quote(join(payload, path))}"`);
  uninstall.push(`Delete "$INSTDIR\\${quote(path.replaceAll("/", "\\"))}"`);
  for (let parent = dirname(path); parent !== "."; parent = dirname(parent)) directories.add(parent.replaceAll("/", "\\"));
}
for (const folder of [...directories].sort((a, b) => b.length - a.length)) uninstall.push(`RMDir "$INSTDIR\\${quote(folder)}"`);
const installPath = join(stage, "install.nsh"), uninstallPath = join(stage, "uninstall.nsh");
await writeFile(installPath, install.join("\n")); await writeFile(uninstallPath, uninstall.join("\n"));
const verifyPath = join(stage, "verify.nsh");
await writeFile(verifyPath, [...directories, ...files.map((path) => path.replaceAll("/", "\\"))]
  .map((path) => `!insertmacro RejectReparse "$INSTDIR\\${quote(path)}"`).join("\n"));
const product = options["--test-id"] ? `CodexQuotaScheduler.Acceptance-${options["--test-id"]}` : "CodexQuotaScheduler";
compile("windows.nsi", { OUTPUT: setup, VERSION: source.version, PRODUCT_KEY: product, SHORTCUT_GROUP: product,
  COMPRESSION: options["--test-id"] ? "zlib" : "lzma",
  INSTALL_DIR: options["--test-id"] ? join(root, ".local", `installer-acceptance-${options["--test-id"]}`, "安装目录 中文", "CodexQuotaScheduler").replaceAll("$", "$$") : "$LOCALAPPDATA\\Programs\\CodexQuotaScheduler",
  INSTALL_FILES: installPath, UNINSTALL_FILES: uninstallPath, VERIFY_PATHS: verifyPath });
const hashes = {};
for (const path of files) hashes[path] = createHash("sha256").update(await readFile(join(payload, path))).digest("hex");
const sha256 = createHash("sha256").update(await readFile(setup)).digest("hex");
await writeFile(setup + ".sha256", `${sha256}  ${basename(setup)}\n`);
await writeFile(join(output, "release.json"), JSON.stringify({ product, version: source.version, platform: "win32-x64", unsigned: true,
  compiler: nsisRelease.version, file: basename(setup), sha256, files: hashes }, null, 2) + "\n");
console.log(JSON.stringify({ installer: setup, sha256, files: files.length }));
