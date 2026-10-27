/** Coalesce reads of one selection and ignore both results and errors from abandoned selections. */
export class SelectedResource<T> {
  id: string | null = null;
  private revision = 0;
  private pending: { id: string; promise: Promise<void> } | undefined;
  constructor(private readonly read: (id: string) => Promise<T>, private readonly apply: (value: T) => void) {}
  select(id: string | null): void { if (this.id !== id) { this.id = id; this.revision++; this.pending = undefined; } }
  load(): Promise<void> {
    const id = this.id, revision = this.revision;
    if (!id) return Promise.resolve();
    if (this.pending?.id === id) return this.pending.promise;
    const promise = this.read(id).then((result) => { if (id === this.id && revision === this.revision) this.apply(result); })
      .catch((error: unknown) => { if (id === this.id && revision === this.revision) throw error; })
      .finally(() => { if (this.pending?.promise === promise) this.pending = undefined; });
    this.pending = { id, promise }; return promise;
  }
}
