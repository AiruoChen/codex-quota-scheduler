import type { TaskRepository } from "../domain/ports.js";
import type { TaskDefinition } from "../domain/task.js";

/** Development adapter only. Replace with durable storage before automatic dispatch. */
export class MemoryTaskRepository implements TaskRepository {
  private readonly tasks = new Map<string, TaskDefinition>();

  async list(): Promise<TaskDefinition[]> {
    return structuredClone([...this.tasks.values()]);
  }

  async save(task: TaskDefinition): Promise<void> {
    this.tasks.set(task.id, structuredClone(task));
  }

  async remove(id: string): Promise<void> {
    this.tasks.delete(id);
  }
}
