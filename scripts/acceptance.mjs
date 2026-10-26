import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { release as osRelease } from "node:os";
import { root } from "./lib/runtime-files.mjs";
import { runAcceptanceCommand } from "./lib/acceptance-command.mjs";
import { generatedDirectory, inspectInstaller, inspectPayload, jsonFile, sourceIdentity, verifyPayloadHashes } from "./lib/release-files.mjs";
import { acceptanceMarkdown, assembleBundle } from "./lib/release-bundle.mjs";
import { automatedChecks, readAcceptance } from "../dist/src/domain/release.js";

if (process.platform !== "win32" || process.arch !== "x64") throw new Error("ACCEPTANCE_WINDOWS_X64_REQUIRED");
const args = process.argv.slice(2), options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!["--output-name", "--soak-seconds", "--sign"].includes(args[i]) || !args[i + 1] || options[args[i]]) throw new Error("ACCEPTANCE_ARGUMENT_INVALID");
  options[args[i]] = args[i + 1];
}
const name = options["--output-name"] ?? `acceptance-${randomUUID()}`, seconds = Number(options["--soak-seconds"] ?? 60);
if (!/^[a-zA-Z0-9_-]+$/.test(name) || !Number.isInteger(seconds) || seconds < 10 || seconds > 172800 || ![undefined, "yes"].includes(options["--sign"])) throw new Error("ACCEPTANCE_ARGUMENT_INVALID");
const output = await generatedDirectory(join(".release", name), true), logs = join(root, ".local", name);
await mkdir(logs, { recursive: true });
const source = sourceIdentity(), pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const checks = automatedChecks.map((id) => ({ id, status: "pending", durationMs: 0, count: 0 }));
let installer, soak = null;
const report = () => readAcceptance({ format: 1, version: pkg.version, ...source, installerSha256: installer?.sha256 ?? "0".repeat(64), createdAt: new Date().toISOString(),
  environment: { platform: process.platform, arch: process.arch, node: process.versions.node, os: osRelease() }, checks, soak });
const npm = process.env.npm_execpath ?? join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
let current;
async function step(id, command, args, count) {
  current = id; const result = await runAcceptanceCommand(id, command, args, join(logs, id + ".log"));
  Object.assign(checks.find((check) => check.id === id) ?? {}, { status: "passed", durationMs: result.durationMs, count: count ?? result.count });
  console.log(JSON.stringify({ step: id, passed: true })); return result;
}
try {
  await step("check", process.execPath, [npm, "run", "check"]);
  await step("unit", process.execPath, [npm, "test"]);
  await step("demo", process.execPath, [npm, "run", "demo"]);
  await step("package", process.execPath, [npm, "run", "package:desktop", "--", "--output-name", name + "-desktop"]);
  const desktop = join(root, ".release", name + "-desktop/CodexQuotaScheduler-win32-x64");
  const installerDir = join(root, ".release", name + "-installer");
  await step("package_installer", process.execPath, [join(root, "scripts/package-installer.mjs"), "--package", desktop, "--output-name", name + "-installer"]);
  if (options["--sign"] === "yes") await step("sign", join(process.env.SystemRoot ?? "C:/Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-File", join(root, "scripts/sign-installer.ps1"), "-Directory", installerDir]);
  installer = await inspectInstaller(installerDir);
  const privacyStart = performance.now(); const privacy = await inspectPayload(desktop);
  await verifyPayloadHashes(desktop, installer.files);
  Object.assign(checks.find((check) => check.id === "privacy"), { status: "passed", durationMs: Math.round(performance.now() - privacyStart), count: privacy.files });
  const gui = await step("desktop", process.execPath, ["--experimental-sqlite", "scripts/smoke-desktop.mjs", "--packaged", join(desktop, "CodexQuotaScheduler.exe")]);
  const guiReport = JSON.parse(await readFile(join(gui.summary.artifacts, "result.json"), "utf8"));
  if (!guiReport.packaged || guiReport.scriptErrors !== 0 || !guiReport.gracefulExit || !guiReport.initiallyPaused) throw new Error("ACCEPTANCE_DESKTOP_INVALID");
  const lifecycle = await step("lifecycle", process.execPath, ["--experimental-sqlite", "scripts/smoke-lifecycle.mjs", "--packaged", join(desktop, "CodexQuotaScheduler.exe")]);
  if (!lifecycle.summary || lifecycle.summary.scenarios < 8) throw new Error("ACCEPTANCE_LIFECYCLE_INVALID");
  checks.find((check) => check.id === "lifecycle").count = lifecycle.summary.scenarios;
  const install = await step("installer", process.execPath, ["--experimental-sqlite", "scripts/smoke-installer.mjs", "--package", desktop]);
  const installReport = JSON.parse(await readFile(join(install.summary.artifacts, "result.json"), "utf8"));
  if (installReport.realTasksSubmitted !== false || installReport.scriptErrors !== 0 || !installReport.uninstallPreservesData || !installReport.migrationSourceUnchanged) throw new Error("ACCEPTANCE_INSTALLER_INVALID");
  const stability = await step("soak_smoke", process.execPath, ["--experimental-sqlite", "scripts/soak-desktop.mjs", "--package", desktop, "--installer", installerDir, "--seconds", String(seconds)]);
  const measured = JSON.parse(await readFile(join(stability.summary.artifacts, "result.json"), "utf8"));
  if (measured.commit !== source.commit || measured.installerSha256 !== installer.sha256 || measured.version !== pkg.version) throw new Error("ACCEPTANCE_SOURCE_CHANGED");
  soak = measured;
  await verifyPayloadHashes(desktop, installer.files); await inspectInstaller(installerDir);
  const after = sourceIdentity();
  if (after.commit !== source.commit || after.clean !== source.clean) throw new Error("ACCEPTANCE_SOURCE_CHANGED");
  const complete = report(); await jsonFile(join(output, "report.json"), complete);
  await import("node:fs/promises").then((fs) => fs.writeFile(join(output, "report.md"), acceptanceMarkdown(complete)));
  if (source.clean) await assembleBundle(installerDir, complete, join(".release", name, "bundle"));
  console.log(JSON.stringify({ passed: true, report: join(output, "report.json"), bundleReady: source.clean, sourceClean: source.clean }));
} catch (error) {
  const item = checks.find((check) => check.id === current); if (item) item.status = "failed";
  await jsonFile(join(output, "report.json"), report());
  console.error(error instanceof Error && /^[A-Z0-9_:,]+$/.test(error.message) ? error.message : "ACCEPTANCE_FAILED"); process.exitCode = 1;
}
