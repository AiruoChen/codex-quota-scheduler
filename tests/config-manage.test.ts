import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { ConfigManager } from "../src/config/manage.js";
import { loadConfig } from "../src/config/load.js";

test("配置初始化、校验保存与有效备份恢复；错误值不修改原文件", async () => {
  const dir = await mkdtemp(join(tmpdir(), "config-manager-test-"));
  try {
    const path = join(dir, "local.json");
    const manager = new ConfigManager(path);
    const created = await manager.init("config/example.json");
    assert.equal(created.tasksFile, resolve("examples/tasks.json"));
    await assert.rejects(manager.init("config/example.json"), { code: "CONFIG_EXISTS" });
    await manager.set("reservePercent", 25);
    assert.equal((await new ConfigManager(path).show()).reservePercent, 25);
    const valid = await readFile(path, "utf8");
    await assert.rejects(manager.set("reservePercent", 101));
    assert.equal(await readFile(path, "utf8"), valid);
    await assert.rejects(manager.set("__proto__.polluted", true), { code: "INVALID_CONFIG_KEY" });
    await writeFile(path, "broken JSON");
    await manager.restore();
    assert.equal((await loadConfig(path)).reservePercent, 10);
    assert.equal(await readFile(path, "utf8"), await readFile(path + ".bak", "utf8"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("设置配置保留原相对路径，锁冲突不删除另一个写入者的锁", async () => {
  const dir = await mkdtemp(join(tmpdir(), "config-lock-test-"));
  try {
    const path = join(dir, "local.json");
    const original = await readFile("config/example.json", "utf8");
    await writeFile(path, original);
    const manager = new ConfigManager(path);
    await manager.set("codex.requestTimeoutMs", 20000);
    const raw = JSON.parse(await readFile(path, "utf8")) as { tasksFile: string };
    assert.equal(raw.tasksFile, "../examples/tasks.json");
    await writeFile(path + ".lock", "existing-owner");
    await assert.rejects(manager.set("reservePercent", 20), { code: "CONFIG_BUSY" });
    assert.equal(await readFile(path + ".lock", "utf8"), "existing-owner");
    await rm(path + ".lock");
    await manager.set("provider", "codex");
    assert.equal((await manager.show()).provider, "codex");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
