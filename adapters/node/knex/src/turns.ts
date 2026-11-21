/**
 * Lets one MySQL Preview run at a time through a provider.
 *
 * InnoDB checks a new key for duplicates under a shared lock. When three or more transactions insert
 * the same key and the first one rolls back, as every Preview does, the waiters each hold that shared
 * lock and each need the exclusive one, so InnoDB aborts all but one with a deadlock (error 1213).
 * Sent for real, the first insert commits and the others get a duplicate-key error instead, and no
 * isolation level avoids it. Previews therefore take turns, as SQLite previews queue for the write lock.
 */
export class PreviewTurns {
  #tail: Promise<void> = Promise.resolve();

  /** Run `operation` once every earlier operation has settled, whether it succeeded or failed. */
  async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>(resolve => { release = resolve; });
    try {
      await previous;
      return await operation();
    } finally {
      release();
    }
  }
}
