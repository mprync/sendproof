const recoveryMessage = 'The TypeORM source requires recovery after transaction cleanup failed.';

/**
 * Serializes operations on drivers that share one physical connection.
 *
 * SQLite drivers multiplex every query runner over a single connection, so an ordinary request
 * that ran while a Preview transaction was open would execute inside that transaction and be
 * rolled back with it. Pooled drivers (PostgreSQL, MySQL) hand each query runner its own
 * connection and bypass the queue entirely.
 */
export class ConnectionLease {
  readonly #serialized: boolean;
  #queue: Promise<void> = Promise.resolve();
  #invalid = false;

  constructor(serialized: boolean) {
    this.#serialized = serialized;
  }

  /** Refuse further work after a rollback or release failure left the connection in doubt. */
  invalidate(): void {
    this.#invalid = true;
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    this.#assertUsable();
    if (!this.#serialized) return operation();
    const previous = this.#queue;
    let release!: () => void;
    this.#queue = new Promise<void>(resolve => { release = resolve; });
    try {
      await previous;
      this.#assertUsable();
      return await operation();
    } finally {
      release();
    }
  }

  #assertUsable(): void {
    if (this.#invalid) throw new Error(recoveryMessage);
  }
}
