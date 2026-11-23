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
  #pending = 0;

  /** Run `operation` once every earlier operation has settled, whether it succeeded or failed. */
  async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#tail;
    const release = this.#reserve();
    try {
      await previous;
      return await operation();
    } finally {
      release();
    }
  }

  /** Sessions can hold a turn for minutes, so decline if one is already taken or queued. */
  tryEnter(): (() => void) | undefined {
    if (this.#pending) return undefined;
    return this.#reserve();
  }

  #reserve(): () => void {
    this.#pending++;
    let done!: () => void;
    this.#tail = new Promise<void>(resolve => { done = resolve; });
    return () => {
      this.#pending--;
      done();
    };
  }
}
