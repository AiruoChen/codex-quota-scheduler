import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { automatedChecks, manualChecks } from "../dist/src/domain/release.js";
import { acceptanceMarkdown, assembleBundle, verifyBundle } from "../scripts/lib/release-bundle.mjs";
import { digest, fileDigest, generatedDirectory, inspectInstaller, localPath } from "../scripts/lib/release-files.mjs";
import { root } from "../scripts/lib/runtime-files.mjs";

const commit = "a".repeat(40);
const version = "0.3.0";
const filename = `CodexQuotaScheduler-${version}-win-x64-setup.exe`;

async function fixture(t) {
  const privateDir = await mkdtemp(join(tmpdir(), "release-tools-"));
  assert.equal(resolve(dirname(privateDir)), resolve(tmpdir()));
  assert.ok(basename(privateDir).startsWith("release-tools-"));
  t.after(async () => { await rm(privateDir, { recursive: true, force: true }); });
  const installerDir = join(privateDir, "installer");
  await mkdir(installerDir);
  await writeFile(join(installerDir, filename), "test-installer-bytes");
  const installerSha256 = await fileDigest(join(installerDir, filename));
  await writeFile(join(installerDir, filename + ".sha256"), `${installerSha256}  ${filename}\n`);
  await writeFile(join(installerDir, "release.json"), JSON.stringify({
    product: "CodexQuotaScheduler", version, platform: "win32-x64", unsigned: true,
    file: filename, sha256: installerSha256, files: {
      "CodexQuotaScheduler.exe": "c".repeat(64),
      "maintenance-guard.exe": "c".repeat(64),
      "resources/app/package.json": "c".repeat(64),
      "resources/app/dist/src/desktop/bootstrap.js": "c".repeat(64),
    },
  }));
  const report = {
    format: 1, version, commit, clean: true, installerSha256, createdAt: new Date().toISOString(),
    environment: { platform: "win32", arch: "x64", node: "v22.12.0", os: "Windows_NT" },
    checks: automatedChecks.map((id) => ({ id, status: "passed", durationMs: 1, count: 1 })),
    soak: { scope: "desktop_protocol_fixture", completed: true, requestedMs: 10_000, elapsedMs: 10_001, wallMs: 10_001,
      maxGapMs: 1200, samples: 10, monitorUpdates: 2, notificationCount: 1,
      submissions: 10, uniqueRuns: 10, leakedChildren: 0, peakBytes: 100_000_000, growthBytes: 0, heapPeakBytes: 2_000_000 },
  };
  const target = `.release/release-tools-${randomUUID()}`;
  const bundle = await assembleBundle(installerDir, report, target);
  assert.equal(resolve(dirname(bundle)), resolve(join(root, ".release")));
  t.after(async () => { await rm(bundle, { recursive: true, force: true }); });
  return { bundle, installerSha256, privateDir, installerDir };
}

async function refreshHashes(bundle, names) {
  const manifest = JSON.parse(await readFile(join(bundle, "bundle.json"), "utf8"));
  for (const name of names) {
    manifest.files[name] = { sha256: await fileDigest(join(bundle, name)), bytes: (await stat(join(bundle, name))).size };
  }
  await writeFile(join(bundle, "bundle.json"), JSON.stringify(manifest));
  const sums = [];
  for (const name of [...Object.keys(manifest.files), "bundle.json"].sort()) sums.push(`${await fileDigest(join(bundle, name))}  ${name}`);
  await writeFile(join(bundle, "SHA256SUMS"), sums.join("\n") + "\n");
}

test("候选版产物验明来源与安装器摘要，改动任一资产会被拒绝", async (t) => {
  const { bundle, installerSha256 } = await fixture(t);
  const valid = await verifyBundle(bundle, { expectedCommit: commit });
  assert.equal(valid.installerSha256, installerSha256);
  assert.equal(valid.signed, false);
  await assert.rejects(verifyBundle(bundle, { expectedCommit: "d".repeat(40) }), /RELEASE_BUNDLE_INVALID/);
  await assert.rejects(verifyBundle(bundle, { channel: "preview" }), /RELEASE_CHANNEL_INVALID/);
  const original = await readFile(join(bundle, "report.md"));
  await writeFile(join(bundle, "report.md"), "tampered\n");
  await assert.rejects(verifyBundle(bundle), /RELEASE_ASSET_HASH_MISMATCH/);
  await writeFile(join(bundle, "report.md"), original);
  await writeFile(join(bundle, "extra.txt"), "personal data");
  await assert.rejects(verifyBundle(bundle), /RELEASE_EXTRA_ASSET_REJECTED/);
});

test("即使攻击者重算摘要，公开报告与清单也不能夹带私密字段", async (t) => {
  const { bundle } = await fixture(t);
  const report = JSON.parse(await readFile(join(bundle, "report.json"), "utf8"));
  report.account = "private@example.com";
  await writeFile(join(bundle, "report.json"), JSON.stringify(report));
  await refreshHashes(bundle, ["report.json"]);
  await assert.rejects(verifyBundle(bundle), /RELEASE_PRIVATE_REPORT_FIELD/);
});

test("安装清单夹带字段和伪造签名状态均被拒绝", async (t) => {
  const { bundle } = await fixture(t);
  const manifest = JSON.parse(await readFile(join(bundle, "release.json"), "utf8"));
  manifest.account = "private@example.com";
  await writeFile(join(bundle, "release.json"), JSON.stringify(manifest));
  await refreshHashes(bundle, ["release.json"]);
  await assert.rejects(verifyBundle(bundle), /RELEASE_PRIVATE_MANIFEST_FIELD/);
  delete manifest.account;
  manifest.unsigned = false;
  await writeFile(join(bundle, "release.json"), JSON.stringify(manifest));
  await refreshHashes(bundle, ["release.json"]);
  await assert.rejects(verifyBundle(bundle), /RELEASE_SIGNATURE_MANIFEST_MISMATCH/);
});

test("安装文件清单拒绝账户数据目录和持久化数据库", async (t) => {
  const { installerDir } = await fixture(t);
  const path = join(installerDir, "release.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  for (const privateName of ["resources/app/.codex/auth.json", "resources/app/data/state.sqlite", "resources/app/tests/fixture.txt"]) {
    manifest.files[privateName] = "c".repeat(64);
    await writeFile(path, JSON.stringify(manifest));
    await assert.rejects(inspectInstaller(installerDir), /RELEASE_PRIVATE_FILE/);
    delete manifest.files[privateName];
  }
});

test("验收包报告标明打包时状态，发布正文可用真实人工证据重新计算", async (t) => {
  const { bundle } = await fixture(t);
  const report = JSON.parse(await readFile(join(bundle, "report.json"), "utf8"));
  const packaged = acceptanceMarkdown(report);
  assert.match(packaged, /生成验收包时的稳定版待补项/);
  assert.match(packaged, /MANUAL_REAL_ACCOUNT/);
  const manual = { format: 1, version: report.version, commit: report.commit, installerSha256: report.installerSha256,
    checks: manualChecks.map((id) => ({ id, status: "passed", method: id === "real_account" ? "real_account" : "human_observed",
      observedAt: new Date().toISOString(), reviewer: "release_reviewer" })) };
  const atPublish = acceptanceMarkdown(report, false, manual);
  assert.match(atPublish, /稳定版发布门禁/);
  assert.doesNotMatch(atPublish, /MANUAL_REAL_ACCOUNT/);
  assert.match(atPublish, /SOAK_24H_REQUIRED/);
});

test("发布路径限制在专用目录，拒绝遍历与控制字符", async () => {
  for (const name of ["../secret", "a/../b", "/private", "C:/secret", "a\\b", "a\0b", "a//b", "a/./b"]) {
    assert.throws(() => localPath(name), /RELEASE_PATH_INVALID/);
  }
  assert.equal(localPath("resources/app/package.json"), "resources/app/package.json");
  await assert.rejects(generatedDirectory(".release-evil/x", true), /RELEASE_OUTPUT_INVALID/);
  await assert.rejects(generatedDirectory("../private/x", true), /RELEASE_OUTPUT_INVALID/);
  assert.equal(digest(Buffer.from("bytes")), "277089d91c0bdf4f2e6862ba7e4a07605119431f5d13f726dd352b06f1b206a9");
});
