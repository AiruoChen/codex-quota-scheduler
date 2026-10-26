import { createHash, randomUUID } from "node:crypto";
import { copyFile, open, readFile, readdir, rename, writeFile, realpath } from "node:fs/promises";
import { join, resolve, dirname, basename } from "node:path";
import { loadConfig } from "../config/load.js";
import { ConfigManager } from "../config/manage.js";
import type { DesktopDataView, ImportPreview } from "../domain/data-transfer.js";
import { AppError } from "../shared/errors.js";
import { isRecord } from "../shared/validation.js";
import { readInstance, runtimePaths } from "../runtime/instance.js";
import { inspectProfileDatabase, snapshotProfileDatabase } from "../storage/profile-snapshot.js";
import { SqliteStore } from "../storage/sqlite-store.js";
import { migrations } from "../storage/database.js";
import { scanRecovery } from "../storage/recovery-repository.js";
import { loadTasks } from "../tasks/load.js";
import type { DesktopOptions } from "./profile.js";
import { atomicDataFile, dataLock, exists, managedDirectory, previousJson, saveDataJson } from "./data-files.js";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const checksum = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const selectionPath = (directory: string) => join(directory, "desktop-profile.json");
const profilePath = (directory: string, id: string) => id === "default" ? join(directory, "config/local.json") : join(directory, "profiles", id, "config.json");
function profileId(value: unknown): value is string { return typeof value === "string" && (value === "default" || uuid.test(value)); }
function compareVersions(a: string, b: string): number {
  if (![a, b].every((value) => /^\d+\.\d+\.\d+$/.test(value))) throw new AppError("MIGRATION_STATE_INVALID", "客户端版本记录不可验证。");
  const left = a.split(".").map(Number), right = b.split(".").map(Number);
  return left.map((value, i) => Math.sign(value - right[i]!)).find(Boolean) ?? 0;
}

export async function selectedProfile(directory: string): Promise<string> {
  const value = await previousJson(selectionPath(directory));
  if (value === null) return profilePath(directory, "default");
  if (!isRecord(value) || value.version !== 1 || !profileId(value.profile)) throw new AppError("MIGRATION_STATE_INVALID", "活动数据配置损坏，请保留原文件与有效备份。");
  const selected = profilePath(directory, value.profile);
  await managedDirectory(dirname(selected));
  return selected;
}

async function noService(configPath: string): Promise<void> {
  if (await readInstance(configPath) || await exists(runtimePaths(configPath).record + ".lock") || await exists(configPath + ".lock")) {
    throw new AppError("MIGRATION_SOURCE_ACTIVE", "配置仍有服务记录或写锁，请先安全停止；遗留记录须显式核对。");
  }
}

async function verifyBundle(configPath: string, clientVersion: string): Promise<void> {
  const manifest = await previousJson(join(dirname(configPath), "backup-manifest.json"));
  if (manifest === null) return;
  if (basename(configPath) !== "config.json" || !isRecord(manifest) || manifest.format !== 1 || manifest.product !== "codex-quota-scheduler" || manifest.complete !== true
    || typeof manifest.clientVersion !== "string" || !isRecord(manifest.hashes) || !Number.isFinite(Date.parse(String(manifest.createdAt)))) throw new AppError("MIGRATION_BACKUP_INVALID", "备份清单无效或尚未完成。");
  if (compareVersions(manifest.clientVersion, clientVersion) > 0) throw new AppError("DESKTOP_DOWNGRADE", "备份来自更新的客户端，请使用匹配版本。");
  for (const name of ["config.json", "state.sqlite", "tasks.json", "source-config.json"]) {
    if (typeof manifest.hashes[name] !== "string" || checksum(await readFile(join(dirname(configPath), name))) !== manifest.hashes[name]) {
      throw new AppError("MIGRATION_BACKUP_INVALID", "备份校验和不匹配，请保留文件核对其他有效备份。");
    }
  }
}

/** Only local file/SQLite work. This class never contacts Codex, stops a remote turn or releases execution ownership. */
export class DesktopDataTransfer {
  private operation = false;
  private plan: { preview: ImportPreview; configHash: string; tasksHash: string; backup: string } | null = null;
  private lastBackup: string | null = null;
  private code: string | null = null;
  constructor(readonly options: DesktopOptions, readonly version: string, readonly explicitConfig = false,
    private readonly changed: () => void = () => {}, private readonly now: () => Date = () => new Date()) {}

  get busy(): boolean { return this.operation; }
  async view(): Promise<DesktopDataView> {
    const profiles: DesktopDataView["profiles"] = [];
    const ids = ["default"];
    if (await exists(join(this.options.dataDir, "profiles"))) {
      ids.push(...(await readdir(join(this.options.dataDir, "profiles"))).filter((id) => uuid.test(id)));
    }
    for (const id of ids) {
      const config = profilePath(this.options.dataDir, id);
      if (await exists(config)) profiles.push({ id, config, active: resolve(config) === resolve(this.options.configPath) });
    }
    return { busy: this.busy, config: this.options.configPath, directory: this.options.dataDir, version: this.version,
      schema: migrations.length, preview: this.plan?.preview ?? null, profiles, backup: this.lastBackup, code: this.code };
  }
  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (this.operation) throw new AppError("MIGRATION_BUSY", "已有数据操作正在进行。");
    this.operation = true; this.code = null; this.changed();
    try {
      await managedDirectory(this.options.dataDir);
      return await dataLock(join(this.options.dataDir, "data-transfer.lock"), work);
    } catch (error) {
      this.code = error instanceof AppError ? error.code : "MIGRATION_FAILED"; throw error;
    } finally { this.operation = false; this.changed(); }
  }
  private async source(configPath: string) {
    const canonical = await realpath(configPath), normalized = resolve(configPath);
    if ((process.platform === "win32" ? canonical.toLowerCase() !== normalized.toLowerCase() : canonical !== normalized)) {
      throw new AppError("MIGRATION_PATH", "请选择原配置的实际路径，不通过符号链接或目录联接迁移。");
    }
    await noService(configPath); await verifyBundle(configPath, this.version);
    const config = await loadConfig(configPath);
    if (config.storage.databasePath === ":memory:") throw new AppError("MIGRATION_DATABASE", "内存数据库不能迁移，请选择持久化数据。");
    const inspection = inspectProfileDatabase(config.storage.databasePath);
    const tasks = await this.sourceTasks(config.tasksFile, inspection.seeded);
    return { config, inspection, raw: await readFile(configPath), tasks };
  }
  private async sourceTasks(path: string, seeded: boolean) {
    try { return await loadTasks(path); }
    catch (error) { if (seeded && (error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }
  async preview(sourcePath: string): Promise<ImportPreview> {
    return this.exclusive(async () => {
      if (this.explicitConfig) throw new AppError("MIGRATION_PINNED_CONFIG", "当前使用命令行指定的配置，请以默认桌面配置启动后导入。");
      this.plan = null;
      const source = resolve(sourcePath), { config, inspection, raw, tasks } = await this.source(source);
      await managedDirectory(join(this.options.dataDir, "profiles"));
      const token = randomUUID(), target = join(this.options.dataDir, "profiles", token), createdAt = this.now().toISOString();
      const preview: ImportPreview = { ...inspection, token, source, sourceDatabase: config.storage.databasePath,
        target, provider: config.provider, createdAt };
      const backup = join(this.options.dataDir, "backups", `import-${token}`);
      this.plan = { preview, configHash: checksum(raw), tasksHash: checksum(JSON.stringify(tasks)), backup }; return preview;
    });
  }
  private async bundle(configPath: string, directory: string, expected?: string): Promise<string> {
    const { config, inspection, raw, tasks } = await this.source(configPath);
    if (expected && inspection.fingerprint !== expected) throw new AppError("MIGRATION_CHANGED", "预检后源数据库变化，请重新预检。");
    if (await exists(directory)) throw new AppError("MIGRATION_TARGET_EXISTS", "备份目标已存在，不会覆盖。");
    await managedDirectory(directory);
    const database = join(directory, "state.sqlite");
    snapshotProfileDatabase(config.storage.databasePath, database, inspection.fingerprint);
    await noService(configPath);
    if (checksum(await readFile(configPath)) !== checksum(raw) || checksum(JSON.stringify(await this.sourceTasks(config.tasksFile, inspection.seeded))) !== checksum(JSON.stringify(tasks))) {
      throw new AppError("MIGRATION_CHANGED", "备份期间源配置或任务导入清单变化，请重新预检。");
    }
    await writeFile(join(directory, "source-config.json"), raw, { flag: "wx", mode: 0o600 });
    await writeFile(join(directory, "tasks.json"), JSON.stringify(tasks, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    // Codex home/executable and task/project paths were resolved against their ORIGINAL locations. Credentials are never copied.
    await new ConfigManager(join(directory, "config.json")).create({ ...config, tasksFile: "tasks.json", storage: { databasePath: "state.sqlite" } });
    const hashes: Record<string, string> = {};
    for (const name of ["config.json", "state.sqlite", "tasks.json", "source-config.json"]) {
      const handle = await open(join(directory, name), "r+");
      try { await handle.sync(); } finally { await handle.close(); }
      hashes[name] = checksum(await readFile(join(directory, name)));
    }
    await saveDataJson(join(directory, "backup-manifest.json"), { product: "codex-quota-scheduler", format: 1, complete: true,
      clientVersion: this.version, createdAt: this.now().toISOString(), schema: inspection.schema, hashes });
    this.lastBackup = directory; return directory;
  }
  async backup(): Promise<string> {
    return this.exclusive(() => this.bundle(this.options.configPath, join(this.options.dataDir, "backups", `manual-${randomUUID()}`)));
  }
  private async checkAndPause(path: string, reason: string): Promise<void> {
    const store = new SqliteStore(path);
    try {
      await store.check();
      store.database.transaction(() => {
        if (scanRecovery(store.database, { now: this.now }).owners.some((owner) => owner.state !== "dead")) {
          throw new AppError("MIGRATION_SOURCE_ACTIVE", "操作前执行进程状态已变化，保持原状态，请安全停止后重试。");
        }
        store.database.connection.prepare("INSERT INTO scheduler_control VALUES(1,1,?,?) ON CONFLICT(singleton) DO UPDATE SET paused=1,reason=excluded.reason,updated_at=excluded.updated_at")
          .run(reason, this.now().toISOString());
      });
    } finally { store.close(); }
  }
  async commit(token: string): Promise<void> {
    return this.exclusive(async () => {
      const plan = this.plan;
      const age = this.now().getTime() - Date.parse(plan?.preview.createdAt ?? "");
      if (!plan || plan.preview.token !== token || age < 0 || age > 10 * 60000) {
        throw new AppError("MIGRATION_PREVIEW_EXPIRED", "导入预览不存在或已过期，请重新预检。");
      }
      await noService(this.options.configPath);
      const { preview } = plan;
      const source = await this.source(preview.source);
      if (checksum(source.raw) !== plan.configHash || checksum(JSON.stringify(source.tasks)) !== plan.tasksHash || source.inspection.fingerprint !== preview.fingerprint) {
        this.plan = null; throw new AppError("MIGRATION_CHANGED", "预览后源配置、任务清单或数据库已变化，请重新预检。");
      }
      const stage = join(this.options.dataDir, "profiles", `.stage-${token}`);
      if (await exists(preview.target) || await exists(stage)) throw new AppError("MIGRATION_TARGET_EXISTS", "目标或暂存目录已存在，不会覆盖。请保留失败记录并重新预检。");
      try {
        await this.bundle(preview.source, plan.backup, preview.fingerprint);
        if (checksum(await readFile(join(plan.backup, "source-config.json"))) !== plan.configHash
          || checksum(JSON.stringify(JSON.parse(await readFile(join(plan.backup, "tasks.json"), "utf8")))) !== plan.tasksHash) {
          throw new AppError("MIGRATION_CHANGED", "备份与预览来源不一致，请重新预检。");
        }
        await managedDirectory(stage);
        await copyFile(join(plan.backup, "state.sqlite"), join(stage, "state.sqlite"));
        await copyFile(join(plan.backup, "tasks.json"), join(stage, "tasks.json"));
        await new ConfigManager(join(stage, "config.json")).create({ ...source.config, tasksFile: "tasks.json", storage: { databasePath: "state.sqlite" } });
        await this.checkAndPause(join(stage, "state.sqlite"), "desktop_import");
        await saveDataJson(join(stage, "profile.json"), { format: 1, clientVersion: this.version, importedAt: this.now().toISOString(), backup: plan.backup });
        await noService(this.options.configPath); await noService(preview.source);
        const finalSource = await this.source(preview.source);
        if (checksum(finalSource.raw) !== plan.configHash || checksum(JSON.stringify(finalSource.tasks)) !== plan.tasksHash || finalSource.inspection.fingerprint !== preview.fingerprint) {
          throw new AppError("MIGRATION_CHANGED", "转换期间源数据发生变化，请重新预检；当前配置保持不变。");
        }
        await rename(stage, preview.target);
        // The profile appears only after a complete validation. The active pointer switches last.
        await this.select(token);
        this.plan = null;
      } catch (error) {
        if (await exists(stage)) await saveDataJson(join(stage, "failure.json"), { code: error instanceof AppError ? error.code : "MIGRATION_FAILED", at: this.now().toISOString() }).catch(() => {});
        throw error;
      }
    });
  }
  private async select(id: string): Promise<void> {
    if (!profileId(id)) throw new AppError("INVALID_ARGUMENT", "数据配置标识无效。");
    const path = profilePath(this.options.dataDir, id);
    await managedDirectory(dirname(path)); await loadConfig(path);
    if (id !== "default") {
      const marker = await previousJson(join(dirname(path), "profile.json"));
      if (!isRecord(marker) || marker.format !== 1 || typeof marker.clientVersion !== "string") throw new AppError("MIGRATION_STATE_INVALID", "数据配置尚未完成导入。");
      if (compareVersions(marker.clientVersion, this.version) > 0) throw new AppError("DESKTOP_DOWNGRADE", "所选数据配置来自更新的客户端。");
    }
    const pointer = selectionPath(this.options.dataDir), previous = await previousJson(pointer);
    if (previous !== null) {
      if (!isRecord(previous) || previous.version !== 1 || !profileId(previous.profile)) throw new AppError("MIGRATION_STATE_INVALID", "活动配置损坏，不会覆盖。");
      await atomicDataFile(pointer + ".bak", JSON.stringify(previous));
    }
    await saveDataJson(pointer, { version: 1, profile: id }); this.options.configPath = path;
  }
  async switchProfile(id: string): Promise<void> {
    return this.exclusive(async () => {
      if (this.explicitConfig) throw new AppError("MIGRATION_PINNED_CONFIG", "命令行固定配置不能在窗口中切换。");
      await noService(this.options.configPath);
      const target = profilePath(this.options.dataDir, id);
      if (!profileId(id)) throw new AppError("INVALID_ARGUMENT", "数据配置标识无效。");
      const config = await loadConfig(target);
      if (await exists(config.storage.databasePath)) await this.source(target);
      else {
        const record = await previousJson(this.versionFile(target));
        if (id !== "default" || isRecord(record) && record.initialized) throw new AppError("STORAGE_MISSING", "所选配置的数据库缺失，请检查备份。");
        await noService(target); // A default profile that has never started may still be intentionally empty.
      }
      await this.select(id); this.plan = null;
    });
  }
  private versionFile(path = this.options.configPath): string {
    const normalized = resolve(path);
    return join(this.options.dataDir, "data-versions", checksum(process.platform === "win32" ? normalized.toLowerCase() : normalized) + ".json");
  }
  async prepareStartup(): Promise<void> {
    return this.exclusive(async () => {
      const config = await loadConfig(this.options.configPath), record = await previousJson(this.versionFile());
      if (config.storage.databasePath === ":memory:") return;
      if (record !== null && (!isRecord(record) || typeof record.clientVersion !== "string" || typeof record.initialized !== "boolean")) {
        throw new AppError("MIGRATION_STATE_INVALID", "数据版本记录损坏，请保留原件与备份。");
      }
      if (isRecord(record) && compareVersions(record.clientVersion as string, this.version) > 0) throw new AppError("DESKTOP_DOWNGRADE", "此数据已由更新版本打开，请使用匹配客户端或从备份导入独立副本。");
      if (!await exists(config.storage.databasePath)) {
        if (isRecord(record) && record.initialized) throw new AppError("STORAGE_MISSING", "已初始化数据库缺失，不会重建空库，请核对备份。");
        await saveDataJson(this.versionFile(), { clientVersion: this.version, initialized: false }); return;
      }
      // An already running external service with the current schema may be attached, but is never upgraded here.
      const external = await readInstance(this.options.configPath);
      const inspection = inspectProfileDatabase(config.storage.databasePath, !!external);
      if (external) {
        if (inspection.schema !== migrations.length) throw new AppError("MIGRATION_SOURCE_ACTIVE", "旧模式服务仍在运行，请先安全停止再升级。");
        return;
      }
      if (inspection.schema === migrations.length && isRecord(record) && record.clientVersion === this.version) {
        await this.checkAndPause(config.storage.databasePath, "desktop_started"); return;
      }
      const backup = await this.bundle(this.options.configPath, join(this.options.dataDir, "backups", `upgrade-${randomUUID()}`));
      await this.checkAndPause(config.storage.databasePath, "desktop_upgrade");
      await saveDataJson(this.versionFile(), { clientVersion: this.version, initialized: true, schema: migrations.length, backup });
    });
  }
  async opened(): Promise<void> {
    await saveDataJson(this.versionFile(), { clientVersion: this.version, initialized: true, schema: migrations.length });
  }
}
