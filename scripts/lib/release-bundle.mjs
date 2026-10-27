import { execFileSync } from "node:child_process";
import { copyFile, readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { readAcceptance, readManualEvidence, releaseGate } from "../../dist/src/domain/release.js";
import { filesIn, fileDigest, generatedDirectory, inspectInstaller, jsonFile, localPath } from "./release-files.mjs";

const publishedFiles = new Set(["report.json", "report.md", "release.json", "RELEASE-NOTES.md", "README.txt"]);
export function signatureVerified(path, thumbprint = process.env.CQS_SIGNING_THUMBPRINT) {
  if (process.platform !== "win32" || !/^[a-fA-F0-9]{40}$/.test(thumbprint ?? "")) return false;
  const script = "$ErrorActionPreference='Stop';$signature=Get-AuthenticodeSignature -LiteralPath $env:CQS_SIGNATURE_FILE;[Console]::Write(($signature.Status -eq 'Valid' -and $signature.SignerCertificate.Thumbprint -eq $env:CQS_SIGNATURE_THUMBPRINT -and $null -ne $signature.TimeStamperCertificate))";
  const result = execFileSync(join(process.env.SystemRoot ?? "C:/Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script],
    { windowsHide: true, encoding: "utf8", env: { ...process.env, CQS_SIGNATURE_FILE: path, CQS_SIGNATURE_THUMBPRINT: thumbprint }, timeout: 30000 });
  return result.trim() === "True";
}
export function acceptanceMarkdown(report, signed = false, manual = null) {
  const gate = releaseGate(report, "stable", manual, signed);
  const gateLabel = manual ? "稳定版发布门禁" : "生成验收包时的稳定版待补项";
  return `# 验收报告\n\n版本：${report.version}；提交：${report.commit}\n\n安装包 SHA256：${report.installerSha256}\n\n环境：${report.environment.platform}/${report.environment.arch}，Node ${report.environment.node}，OS ${report.environment.os}\n\n| 自动检查 | 结果 | 数量 | 实际耗时 ms |\n| --- | --- | --- | --- |\n${report.checks.map((item) => `| ${item.id} | ${item.status} | ${item.count} | ${item.durationMs} |`).join("\n")}\n\n长时运行：${report.soak ? `协议替身桌面运行 ${report.soak.elapsedMs} ms；额度观测更新 ${report.soak.monitorUpdates} 次，通知记录 ${report.soak.notificationCount} 条；提交 ${report.soak.submissions} 次，唯一运行 ${report.soak.uniqueRuns}，遗留子进程 ${report.soak.leakedChildren}。` : "尚无证据。"}\n\n模拟/协议替身测试不代表真实账户执行验收。原生通知实际展示、独立 Windows 环境、显示缩放、完整 P0 人工走查及故障演练另行记录。\n\n${gateLabel}：${gate.blockers.join(", ") || "已通过"}\n`;
}
export async function assembleBundle(installerDir, reportInput, target) {
  const installer = await inspectInstaller(installerDir), report = readAcceptance(reportInput);
  if (installer.sha256 !== report.installerSha256 || installer.version !== report.version) throw new Error("RELEASE_EVIDENCE_MISMATCH");
  const gate = releaseGate(report, "candidate", null, false);
  if (!gate.allowed) throw new Error("RELEASE_GATE_BLOCKED:" + gate.blockers.join(","));
  const directory = await generatedDirectory(target, true), signed = signatureVerified(join(installerDir, installer.file));
  await copyFile(join(installerDir, installer.file), join(directory, installer.file));
  await copyFile(join(installerDir, installer.file + ".sha256"), join(directory, installer.file + ".sha256"));
  await jsonFile(join(directory, "release.json"), { product: "CodexQuotaScheduler", version: installer.version, platform: "win32-x64", file: installer.file,
    sha256: installer.sha256, files: installer.files, unsigned: !signed });
  await jsonFile(join(directory, "report.json"), report);
  await writeFile(join(directory, "report.md"), acceptanceMarkdown(report, signed));
  const notes = await readFile(new URL(`../../docs/RELEASE-NOTES-${report.version}.md`, import.meta.url), "utf8");
  await writeFile(join(directory, "RELEASE-NOTES.md"), notes);
  await writeFile(join(directory, "README.txt"), `Codex Quota Scheduler ${report.version}\n验收产物；候选或正式发布取决于发布门禁。提交 ${report.commit}\n运行 ${installer.file} 按当前用户安装，自带运行时。\n关闭到托盘会保留后台，安全退出等待落盘。首次默认模拟模式，导入后队列暂停。\n安装器签名验证：${signed ? "已验证预期发布者和时间戳" : "未验证，当前不得作为稳定版发布"}\n请阅读 report.md 与 RELEASE-NOTES.md。校验和只验证完整性，不能替代发布者签名。\n`);
  const files = {};
  for (const name of await filesIn(directory)) files[name] = { sha256: await fileDigest(join(directory, name)), bytes: (await stat(join(directory, name))).size };
  await jsonFile(join(directory, "bundle.json"), { format: 1, product: "codex-quota-scheduler", version: report.version, commit: report.commit,
    installerSha256: report.installerSha256, createdAt: report.createdAt, channel: "candidate", files });
  const sums = [];
  for (const name of [...Object.keys(files), "bundle.json"].sort()) sums.push(`${await fileDigest(join(directory, name))}  ${name}`);
  await writeFile(join(directory, "SHA256SUMS"), sums.join("\n") + "\n");
  await verifyBundle(directory);
  return directory;
}

/** Verification is read-only and always rehashes the actual files, including the installer. */
export async function verifyBundle(directory, { channel = "candidate", manual = null, expectedCommit, thumbprint } = {}) {
  if (channel !== "candidate" && channel !== "stable") throw new Error("RELEASE_CHANNEL_INVALID");
  const actual = await filesIn(directory);
  const manifest = JSON.parse(await readFile(join(directory, "bundle.json"), "utf8"));
  if (!manifest || typeof manifest !== "object" || JSON.stringify(Object.keys(manifest).sort()) !== JSON.stringify(["channel", "commit", "createdAt", "files", "format", "installerSha256", "product", "version"])
    || manifest.format !== 1 || manifest.channel !== "candidate" || manifest.product !== "codex-quota-scheduler" || !manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files)
    || !/^[a-f0-9]{40}$/.test(manifest.commit) || expectedCommit && manifest.commit !== expectedCommit) throw new Error("RELEASE_BUNDLE_INVALID");
  const rawReport = JSON.parse(await readFile(join(directory, "report.json"), "utf8"));
  const report = readAcceptance(rawReport);
  if (JSON.stringify(rawReport) !== JSON.stringify(report)) throw new Error("RELEASE_PRIVATE_REPORT_FIELD");
  const installer = await inspectInstaller(directory);
  if (report.commit !== manifest.commit || report.version !== manifest.version || report.version !== installer.version
    || report.installerSha256 !== manifest.installerSha256 || report.installerSha256 !== installer.sha256
    || report.createdAt !== manifest.createdAt) throw new Error("RELEASE_EVIDENCE_MISMATCH");
  const rawInstaller = JSON.parse(await readFile(join(directory, "release.json"), "utf8"));
  const expectedInstaller = { product: "CodexQuotaScheduler", version: installer.version, platform: "win32-x64", file: installer.file,
    sha256: installer.sha256, files: installer.files, unsigned: installer.unsigned };
  if (JSON.stringify(rawInstaller) !== JSON.stringify(expectedInstaller)) throw new Error("RELEASE_PRIVATE_MANIFEST_FIELD");
  const required = new Set([...publishedFiles, installer.file, installer.file + ".sha256"]);
  const names = Object.keys(manifest.files);
  if (names.length !== required.size || names.some((name) => !required.has(name))) throw new Error("RELEASE_ASSETS_INVALID");
  for (const name of names) {
    localPath(name); const entry = manifest.files[name];
    if (!entry || typeof entry !== "object" || JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify(["bytes", "sha256"])
      || !/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes <= 0
      || (await stat(join(directory, name))).size !== entry.bytes || await fileDigest(join(directory, name)) !== entry.sha256) throw new Error("RELEASE_ASSET_HASH_MISMATCH");
  }
  const expected = [...names, "bundle.json", "SHA256SUMS"].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("RELEASE_EXTRA_ASSET_REJECTED");
  const sums = (await readFile(join(directory, "SHA256SUMS"), "utf8")).trim().split("\n");
  const checksums = [];
  for (const name of [...names, "bundle.json"].sort()) checksums.push(`${await fileDigest(join(directory, name))}  ${name}`);
  if (JSON.stringify(sums) !== JSON.stringify(checksums)) throw new Error("RELEASE_CHECKSUM_INVALID");
  const signed = signatureVerified(join(directory, installer.file), thumbprint);
  if (installer.unsigned === signed) throw new Error("RELEASE_SIGNATURE_MANIFEST_MISMATCH");
  const gate = releaseGate(report, channel, manual ? readManualEvidence(manual) : null, signed);
  if (!gate.allowed) throw new Error("RELEASE_GATE_BLOCKED:" + gate.blockers.join(","));
  return { version: report.version, commit: report.commit, installerSha256: installer.sha256, signed, channel, files: expected };
}
