import { execFileSync } from "node:child_process";
import { readFile, appendFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { verifyBundle, acceptanceMarkdown } from "./lib/release-bundle.mjs";
import { fileDigest } from "./lib/release-files.mjs";
import { root } from "./lib/runtime-files.mjs";
import { readAcceptance, readManualEvidence } from "../dist/src/domain/release.js";

const args = process.argv.slice(2), options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!["--directory", "--run-id", "--channel", "--manual", "--prepare"].includes(args[i]) || !args[i + 1] || options[args[i]]) throw new Error("PUBLISH_ARGUMENT_INVALID");
  options[args[i]] = args[i + 1];
}
const runId = options["--run-id"], channel = options["--channel"] ?? "candidate", repository = process.env.GITHUB_REPOSITORY;
if (!/^[1-9][0-9]{0,15}$/.test(runId ?? "") || !["candidate", "stable"].includes(channel) || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository ?? "")) throw new Error("PUBLISH_ARGUMENT_INVALID");
const gh = (args) => execFileSync("gh", args, { windowsHide: true, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const run = JSON.parse(gh(["api", `repos/${repository}/actions/runs/${runId}`]));
const repo = JSON.parse(gh(["api", `repos/${repository}`]));
if (!/^[a-zA-Z0-9._/-]+$/.test(repo.default_branch) || repo.default_branch.startsWith("-")) throw new Error("PUBLISH_BRANCH_INVALID");
if (run.conclusion !== "success" || run.head_repository?.full_name !== repository || run.event !== "push"
  || run.path !== ".github/workflows/ci.yml" || run.head_branch !== repo.default_branch || !/^[a-f0-9]{40}$/.test(run.head_sha)
  || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1) throw new Error("PUBLISH_UNTRUSTED_RUN");
const artifact = `release-candidate-${runId}-${run.run_attempt}`;
if (options["--prepare"] === "yes") {
  if (!process.env.GITHUB_OUTPUT) throw new Error("PUBLISH_OUTPUT_MISSING");
  await appendFile(process.env.GITHUB_OUTPUT, `artifact=${artifact}\ncommit=${run.head_sha}\n`); process.exit(0);
}
if (!options["--directory"]) throw new Error("PUBLISH_ARGUMENT_INVALID");
const directory = resolve(options["--directory"]), manual = options["--manual"] ? JSON.parse(await readFile(options["--manual"], "utf8")) : null;
const verified = await verifyBundle(directory, { channel, manual, expectedCommit: run.head_sha });
const report = readAcceptance(JSON.parse(await readFile(join(directory, "report.json"), "utf8")));
const evidence = manual ? readManualEvidence(manual) : null;
await mkdir(join(root, ".local"), { recursive: true });
const notesDirectory = await mkdtemp(join(root, ".local/publish-notes-"));
const notesFile = join(notesDirectory, "notes.md");
await writeFile(notesFile, `# Codex Quota Scheduler ${verified.version}\n\n发布渠道：${channel === "stable" ? "稳定版" : "候选版"}。\n\n${acceptanceMarkdown(report, verified.signed, evidence)}`);
execFileSync("git", ["fetch", "--no-tags", "origin", repo.default_branch], { windowsHide: true, stdio: "pipe" });
execFileSync("git", ["merge-base", "--is-ancestor", verified.commit, "FETCH_HEAD"], { windowsHide: true, stdio: "pipe" });
const tag = channel === "stable" ? `v${verified.version}` : `v${verified.version}-rc.${runId}.${run.run_attempt}`;
// Never clobber an existing release/tag. gh create fails if the release already exists.
try { gh(["api", `repos/${repository}/git/ref/tags/${tag}`]); throw new Error("PUBLISH_TAG_EXISTS"); }
catch (error) { if (error.message === "PUBLISH_TAG_EXISTS" || !String(error.stderr).includes("404")) throw error; }
gh(["release", "create", tag, "--repo", repository, "--target", verified.commit, "--draft", "--title", `Codex Quota Scheduler ${tag}`,
  "--notes-file", notesFile, ...(channel === "candidate" ? ["--prerelease"] : []), ...verified.files.map((name) => join(directory, name))]);
// Recheck GitHub's uploaded asset digests before making the draft visible.
const uploaded = JSON.parse(gh(["api", `repos/${repository}/releases/tags/${tag}`]));
if (uploaded.assets.length !== verified.files.length) throw new Error("PUBLISH_ASSET_MISMATCH");
for (const name of verified.files) {
  const asset = uploaded.assets.find((item) => item.name === name);
  if (asset?.digest !== "sha256:" + await fileDigest(join(directory, name))) throw new Error("PUBLISH_ASSET_MISMATCH");
}
gh(["release", "edit", tag, "--repo", repository, "--draft=false", channel === "candidate" ? "--latest=false" : "--latest"]);
console.log(JSON.stringify({ published: true, tag, channel, commit: verified.commit }));
