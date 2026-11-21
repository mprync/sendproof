/**
 * Shared harness for the data-store tests: an Express app with a real SQLite rollback provider,
 * driven over loopback HTTP, plus assertions for the blocked-Preview response and helpers that
 * reach the compose services (tests/conformance/compose.yml) or skip when they aren't running.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { connect } from 'node:net';
import type test from 'node:test';
import express from 'express';
import type { Request, Response } from 'express';
import type { DataStore } from '@sendproof/core';
import { sendproof } from '@sendproof/express';
import type { SendproofMiddleware } from '@sendproof/express';
import { SQLiteDatabase } from '@sendproof/sqlite';

/** The shared vectors every binding runs through its classifiers. */
export const cases = JSON.parse(readFileSync(new URL('../../../../spec/data-stores/classification-cases.json', import.meta.url), 'utf8'));

/** Load one shared classification table from spec/data-stores/. */
export const specTable = (store: string) =>
  JSON.parse(readFileSync(new URL(`../../../../spec/data-stores/${store}.json`, import.meta.url), 'utf8'));

/** Compose service addresses, overridable like the conformance runner's. */
export const services = {
  mongodb: process.env.BENCH_MONGODB_SERVER_URL ?? 'mongodb://127.0.0.1:57017/?directConnection=true',
  redis: process.env.BENCH_REDIS_SERVER_URL ?? 'redis://:bench_redis_local@127.0.0.1:56379',
  dynamodb: process.env.BENCH_DYNAMODB_SERVER_URL ?? 'http://127.0.0.1:58000',
};

/** Whether a TCP service answers within half a second. */
export function reachable(url: string): Promise<boolean> {
  const { hostname, port } = new URL(url);
  return new Promise(resolve => {
    const socket = connect({ host: hostname, port: Number(port) });
    const done = (value: boolean) => { socket.destroy(); resolve(value); };
    socket.setTimeout(500, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** The `skip` option for tests that need a compose service. */
export async function needs(store: keyof typeof services): Promise<{ skip?: string }> {
  return await reachable(services[store])
    ? {} : { skip: `${store} is not running: docker compose -f tests/conformance/compose.yml up -d --wait ${store}` };
}

export interface StoreApp {
  url: string;
  db: SQLiteDatabase;
  bench: SendproofMiddleware;
  errors: unknown[];
  /** Send a Preview and return the raw response. */
  preview(method: string, path: string, body?: unknown): Promise<globalThis.Response>;
  /** Send a Preview that must confirm, and return its envelope. */
  confirmed(method: string, path: string, body?: unknown): Promise<PreviewEnvelope>;
  /** Send an observed Send and return the result and its trace. */
  observed(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown; trace: PreviewEnvelope }>;
  capabilities(): Promise<Record<string, any>>;
}

export interface PreviewEnvelope {
  status: number;
  body: any;
  changes: any[];
  logs: any[];
  changesTruncated?: boolean;
}

type Register = (bench: SendproofMiddleware, db: SQLiteDatabase) => void;

/** Wrap an async Express handler so a rejection reaches the error handler. */
export const handle = (run: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: (error?: unknown) => void) => { run(req, res).catch(next); };

/** Start an app with `dataStores` and the routes `register` adds; it closes when the test ends. */
export async function startApp(t: test.TestContext, dataStores: DataStore[], register: Register): Promise<StoreApp> {
  const db = new SQLiteDatabase(':memory:', { schema: 'CREATE TABLE items (id TEXT PRIMARY KEY, name TEXT NOT NULL)' });
  const errors: unknown[] = [];
  const bench = sendproof({
    environment: 'development', previewProvider: db, dataStores,
    resolveIdentity: () => ({ name: 'Tester', subject: 'tester' }),
    onError: error => { errors.push(error); },
  });
  const app = express();
  app.use(express.json());
  app.use(bench);
  register(bench, db);
  app.use((error: unknown, _req: Request, res: Response, _next: unknown) => {
    errors.push(error);
    res.status(500).json({ message: 'failed' });
  });
  const server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(async () => {
    await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
    await db.close();
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (method: string, path: string, body: unknown, headers: Record<string, string>) => fetch(url + path, {
    method, headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const preview = (method: string, path: string, body?: unknown) =>
    call(method, '/sendproof/_preview' + path, body, { prefer: 'tx=rollback', origin: url });
  return {
    url, db, bench, errors, preview,
    async confirmed(method, path, body) {
      const response = await preview(method, path, body);
      const text = await response.text();
      assert.equal(response.status, 200, `Expected a confirmed Preview, got ${response.status}: ${text}`);
      assert.equal(response.headers.get('preference-applied'), 'tx=rollback');
      return JSON.parse(text);
    },
    async observed(method, path, body) {
      const response = await call(method, path, body, { prefer: 'trace', origin: url });
      const id = response.headers.get('x-sendproof-trace');
      const result = { status: response.status, body: await response.json().catch(() => null) };
      assert(id, `Expected a trace for ${method} ${path}`);
      const trace = await (await fetch(url + '/sendproof/_api/traces/' + id, { headers: { origin: url } })).json();
      return { ...result, trace };
    },
    async capabilities() {
      return (await fetch(url + '/sendproof/_api/capabilities')).json();
    },
  };
}

/** Assert the blocked-Preview response: 409 problem+json, no confirmation, naming the refused command. */
export async function assertBlocked(response: globalThis.Response, store: string, operation: string): Promise<Record<string, unknown>> {
  const text = await response.text();
  assert.equal(response.status, 409, `Expected a blocked Preview, got ${response.status}: ${text}`);
  assert.equal(response.headers.get('preference-applied'), null);
  assert.match(response.headers.get('content-type') ?? '', /^application\/problem\+json/);
  assert.match(response.headers.get('cache-control') ?? '', /no-store/);
  const problem = JSON.parse(text);
  assert.equal(problem.code, 'preview_unavailable');
  assert.equal(problem.title, 'Preview unavailable');
  assert.equal(problem.status, 409);
  assert.equal(problem.rolledBack, false);
  assert.equal(problem.store, store);
  assert.equal(String(problem.operation).toUpperCase(), operation.toUpperCase());
  assert.match(problem.detail, /^Preview unavailable: /);
  assert.equal('body' in problem || 'logs' in problem || 'changes' in problem, false, 'A blocked Preview carries nothing the handler made');
  return problem;
}

/** Assert a Preview that failed without confirmation. */
export async function assertUnconfirmed(response: globalThis.Response, status = 500): Promise<void> {
  const text = await response.text();
  assert.equal(response.status, status, `Expected ${status}, got ${response.status}: ${text}`);
  assert.equal(response.headers.get('preference-applied'), null);
  assert(!text.includes('"rolledBack":true'));
}

/** The `Db` entries of a capture, optionally for one store and operation. */
export const dbEntries = (logs: any[], system?: string, operation?: string) => logs.filter(entry => entry.level === 'Db' &&
  (!system || entry.db.system === system) && (!operation || entry.db.operation.toUpperCase() === operation.toUpperCase()));

/** A fresh name for a test's key prefix, collection or table. */
export const fresh = (label: string) => `tb_${label}_${Math.random().toString(16).slice(2, 10)}`;
