import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { DataStore, HeldPreview, SessionAccess } from './types.js';

export class PreviewStoreBusyError extends Error {
  constructor(readonly store: string) { super('A Preview store is busy.'); }
}

export class PreviewSessionEndedError extends Error {}

export class SessionProblem extends Error {
  constructor(readonly status: number, readonly code: string, title: string) {
    super(title);
  }
}

export const notFound = () => new SessionProblem(404, 'session_not_found', 'Preview session not found.');
export const failed = () => new SessionProblem(409, 'session_failed', 'A required Preview transaction is unavailable.');

interface Session {
  id: string;
  owner: string;
  deadline: number;
  idleDeadline: number;
  parts: HeldPreview[];
  guards: DataStore[];
  nextStep: number;
  active?: ReturnType<typeof Promise.withResolvers<void>>;
  timer?: NodeJS.Timeout;
  closing?: Promise<void>;
  onError: (error: unknown) => void;
}

export class Sessions {
  #sessions = new Map<string, Session>();
  #stopping = false;

  constructor(readonly idleTimeoutSeconds: number, readonly maxLifetimeSeconds: number) {
    for (const seconds of [idleTimeoutSeconds, maxLifetimeSeconds]) {
      if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds * 1000 > 2 ** 31 - 1) {
        throw new RangeError('Preview session timeouts must be positive whole seconds within the Node timer range.');
      }
    }
  }

  async open(owner: string, guards: DataStore[], acquire: (add: (part: HeldPreview) => Promise<void>) => Promise<void>,
    onError: (error: unknown) => void) {
    if (this.#stopping) throw failed();
    if (this.#sessions.size >= 16 || [...this.#sessions.values()].filter(session => session.owner === owner).length >= 4) {
      throw new SessionProblem(429, 'session_limit', 'Too many Preview sessions are open. End one first.');
    }

    // Reserve an admission slot before touching any store, including during parallel opens.
    const id = randomBytes(16).toString('hex');
    const now = performance.now();
    const session: Session = {
      id, owner, parts: [], guards, deadline: now + this.maxLifetimeSeconds * 1000, idleDeadline: 0,
      nextStep: 1, active: Promise.withResolvers<void>(), onError,
    };
    this.#sessions.set(id, session);
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        acquire(async part => {
          if (session.closing || this.#stopping) {
            await part.close().catch(onError);
            throw failed();
          }
          session.parts.push(part);
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(failed()), Math.min(4000, this.maxLifetimeSeconds * 1000));
          timer.unref();
        }),
      ]);
      if (this.#stopping || performance.now() >= session.deadline) throw failed();
      return { id, idleTimeoutSeconds: this.idleTimeoutSeconds, maxLifetimeSeconds: this.maxLifetimeSeconds };
    } catch (error) {
      await this.close(session).catch(onError);
      if (error instanceof PreviewStoreBusyError) {
        throw new SessionProblem(409, 'store_busy', `Another Preview session is holding ${error.store}.`);
      }
      onError(error);
      throw failed();
    } finally {
      clearTimeout(timer);
      await this.exit(session);
    }
  }

  enter({ id, owner }: SessionAccess): Session {
    const session = this.#sessions.get(id);
    if (this.#stopping || !session || session.closing || session.owner !== owner) throw notFound();
    const now = performance.now();
    if (now >= session.deadline || (!session.active && now >= session.idleDeadline)) {
      if (!session.active) void this.close(session).catch(session.onError);
      throw notFound();
    }
    if (session.active) throw new SessionProblem(409, 'session_busy', 'The Preview session is serving another request.');
    clearTimeout(session.timer);
    session.active = Promise.withResolvers<void>();
    return session;
  }

  async exit(session: Session) {
    const active = session.active;
    session.active = undefined;
    session.idleDeadline = performance.now() + this.idleTimeoutSeconds * 1000;
    const delay = Math.min(session.idleDeadline, session.deadline) - performance.now();
    try {
      if (session.closing || this.#stopping || delay <= 0) {
        await this.close(session).catch(session.onError);
      } else {
        session.timer = setTimeout(() => void this.close(session).catch(session.onError), Math.ceil(delay));
        session.timer.unref();
      }
    } finally {
      active?.resolve();
    }
  }

  close(session: Session) {
    clearTimeout(session.timer);
    return session.closing ??= (async () => {
      const errors = [];
      try {
        for (const part of session.parts.toReversed()) {
          try { await part.close(); } catch (error) { errors.push(error); }
        }
        if (errors.length) throw new AggregateError(errors, 'Preview session rollback failed.');
      } finally {
        this.#sessions.delete(session.id);
      }
    })();
  }

  async shutdown() {
    this.#stopping = true;
    await Promise.all([...this.#sessions.values()].map(async session => {
      await session.active?.promise;
      await this.close(session).catch(session.onError);
    }));
  }
}
