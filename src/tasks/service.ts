import { readFile } from "node:fs/promises";
import type { StoredTask } from "../domain/task.js";
import { AppError } from "../shared/errors.js";
import type { SqliteStore, TaskImport } from "../storage/sqlite-store.js";
import { definitionOf } from "../storage/task-repository.js";
import { loadTask, loadTasks } from "./load.js";

async function imports(path: string): Promise<TaskImport[]> {
  const tasks = await loadTasks(path);
  return Promise.all(tasks.map(async (task) => ({ task, prompt: await readFile(task.promptFile, "utf8") })));
}

export class TaskService {
  constructor(private readonly store: SqliteStore) {}

  async seed(path: string): Promise<void> {
    if (!this.store.isSeeded()) this.store.import(await imports(path), true);
  }

  async import(path: string): Promise<number> {
    const items = await imports(path);
    this.store.import(items);
    return items.length;
  }

  async add(path: string): Promise<StoredTask> {
    const task = await loadTask(path);
    return this.store.tasks.create(task, await readFile(task.promptFile, "utf8"));
  }

  async update(path: string, revision: number): Promise<StoredTask> {
    const task = await loadTask(path);
    return this.store.tasks.update(task, await readFile(task.promptFile, "utf8"), revision);
  }

  async enable(id: string, enabled: boolean, revision: number): Promise<StoredTask> {
    const task = await this.store.tasks.get(id);
    if (!task) throw new AppError("TASK_NOT_FOUND", "任务不存在或已归档。");
    return this.store.tasks.update({ ...definitionOf(task), enabled }, task.promptSnapshot, revision);
  }
}
