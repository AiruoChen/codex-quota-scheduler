import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "manual-render-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "scripts")); await mkdir(join(directory, "docs"));
  const script = join(directory, "scripts/build-user-manual.mjs");
  await copyFile("scripts/build-user-manual.mjs", script);
  await writeFile(join(directory, "docs/RELEASE-NOTES-0.4.0.md"), "fixture");
  return {
    source: join(directory, "docs/USER-MANUAL.md"), target: join(directory, "docs/USER-MANUAL.html"),
    run: (...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", windowsHide: true, timeout: 10000 }),
  };
}
const markdown = (edition, href) => `# Fixture\n\n适用版本：${edition}**0.4.0 Windows x64 测试客户端**。\n\n[说明](${href})\n\n<a id="section-1"></a>\n## One\n\n<script>fixture</script>\n`;

test("离线手册支持版本号链接和两种版本标题，生成同步且不执行正文 HTML", async t => {
  const env = await fixture(t);
  for (const edition of ["", "完整的 "]) {
    await writeFile(env.source, markdown(edition, "RELEASE-NOTES-0.4.0.md"));
    assert.equal(env.run().status, 0);
    const html = await readFile(env.target, "utf8");
    assert.match(html, /href="RELEASE-NOTES-0\.4\.0\.md"/);
    assert.match(html, /class="edition">0\.4\.0 Windows x64 测试客户端/);
    assert.ok(!html.includes("<script>")); assert.ok(html.includes("&lt;script&gt;"));
    assert.equal(env.run("--check").status, 0);
  }
});

test("离线手册拒绝路径穿越、绝对路径、编码目录及脚本链接", async t => {
  const env = await fixture(t);
  for (const href of ["../auth.json", "/private.md", "file:///private.md", "javascript:fixture", "%2e%2e/private.md", "notes..md"]) {
    await writeFile(env.source, markdown("", href));
    const result = env.run(); assert.notEqual(result.status, 0); assert.match(result.stderr, /MANUAL_LINK_UNSUPPORTED/);
  }
});
