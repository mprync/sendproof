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
  #waiting = 0;

  /** Sessions take an available turn immediately, so a second open cannot wait on the first. */
  tryAcquire(): (() => void) | undefined {
    return this.#waiting === 0 ? this.#enqueue().release : undefined;
  }

  /** Run `operation` once every earlier operation has settled, whether it succeeded or failed. */
  async run<T>(operation: () => Promise<T>): Promise<T> {
    const { previous, release } = this.#enqueue();
    try {
      await previous;
      return await operation();
    } finally {
      release();
    }
  }

  #enqueue() {
    const previous = this.#tail;
    const turn = Promise.withResolvers<void>();
    this.#tail = turn.promise;
    this.#waiting++;
    return { previous, release: () => { this.#waiting--; turn.resolve(); } };
  }
}
