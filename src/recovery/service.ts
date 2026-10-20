import type { RecoveryReader, RecoveryRepository } from "../domain/recovery.js";
import { AppError } from "../shared/errors.js";

export class RecoveryService {
  constructor(readonly repository: RecoveryRepository, private readonly reader: RecoveryReader,
    private readonly options: { provider: "codex" | "mock"; persistent: boolean }) {}

  async inspect(id: string, signal?: AbortSignal) {
    this.requireReal();
    const target = this.repository.target(id);
    const result = await this.read(target, signal);
    return { runId: id, localStatus: target.run.status, result };
  }

  async reconcile(id: string, signal?: AbortSignal) {
    this.requireReal();
    const target = this.repository.beginReconcile(id);
    const result = await this.read(target, signal);
    if (signal?.aborted) throw new AppError("RECOVERY_STOPPED", "核对已停止，未应用远端结果。");
    return { result, run: this.repository.apply(target, result) };
  }

  private async read(target: Parameters<RecoveryReader["read"]>[0], signal?: AbortSignal) {
    try { return await this.reader.read(target, signal); }
    catch (error) {
      if (signal?.aborted) throw new AppError("RECOVERY_STOPPED", "核对已停止。");
      return { kind: "unknown" as const, code: error instanceof AppError && /^[A-Z_]{1,64}$/.test(error.code) ? error.code : "RECOVERY_READ_FAILED" };
    }
  }
  private requireReal(): void {
    if (this.options.provider !== "codex" || !this.options.persistent) throw new AppError("RECOVERY_REQUIRES_CODEX", "远端核对需要 provider=codex 和持久化数据库，模拟来源不能确认真实任务结果。");
  }
}
