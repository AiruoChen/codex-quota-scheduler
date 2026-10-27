import { AppError } from "../shared/errors.js";

export interface ProjectPickerSource { trusted(): boolean; pick(): Promise<string | null> }
/** A single user-driven operation; no caller-supplied path or filesystem capability. */
export class ProjectPicker {
  private pending = false;
  constructor(private readonly source: ProjectPickerSource) {}
  async choose(args: unknown[], trusted = this.source.trusted): Promise<string | null> {
    if (!trusted()) throw new AppError("HTTP_FORBIDDEN", "目录选择仅供当前管理页面使用。");
    if (args.length) throw new AppError("INVALID_ARGUMENT", "目录选择不接受参数。");
    if (this.pending) throw new AppError("MANAGEMENT_BUSY", "目录选择窗口已打开。");
    this.pending = true;
    try { const path = await this.source.pick(); return trusted() ? path : null; }
    finally { this.pending = false; }
  }
}
