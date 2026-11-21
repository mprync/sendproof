import 'reflect-metadata';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test, { after } from 'node:test';
import {
  Body, Controller, Delete, ForbiddenException, Get, Param, Post, Req, Res, UnauthorizedException, UseGuards,
} from '@nestjs/common';
import type { CanActivate, ExecutionContext, INestApplication, Type } from '@nestjs/common';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NextFunction, Request, Response } from 'express';
import { SendproofModule, SendproofPreview } from '@sendproof/nestjs';
import type { NestBenchOptions } from '@sendproof/nestjs';

/** A preview provider that adds no transaction: enough to exercise the module itself. */
const passthrough = { async preview<T>(dispatch: () => Promise<T>): Promise<T> { return dispatch(); } };
const rollback = { Prefer: 'tx=rollback' };
const jsonHeaders = { 'Content-Type': 'application/json' };

/** Role guard driven by the `x-role` header: absent is 401, anything but admin is 403. */
class RoleGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const role = context.switchToHttp().getRequest<Request>().headers['x-role'];
    if (!role) throw new UnauthorizedException();
    if (role !== 'admin') throw new ForbiddenException();
    return true;
  }
}

/** Counts how often each handler body ran, so tests can prove a rejected guard stopped the action. */
const calls = { create: 0, remove: 0 };

class ItemsController {
  find(id: string) { return { id }; }
  create(body: { name: string }) { calls.create++; return { created: body.name }; }
  remove(res: Response) { calls.remove++; res.status(204).end(); }
  stream(res: Response) { res.status(200).send('x'.repeat(32)); }
  hidden() { return { hidden: true }; }
  whoami(req: Request & { actor?: string }) { return { actor: req.actor ?? null }; }
  broken(): never { throw new Error('secret detail'); }
}
Controller('items')(ItemsController);

/*
 * Nest's decorator syntax needs compiler options this package build does not use, so the decorators are applied by hand.
 */
const prototype = ItemsController.prototype;

/** Route one controller action with an HTTP verb decorator plus method decorators. */
function action(name: keyof ItemsController, verb: (path?: string) => MethodDecorator, path: string, ...decorators: MethodDecorator[]) {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, name)!;
  for (const decorator of [verb(path), ...decorators]) decorator(prototype, name, descriptor);
}

/** Bind one parameter of a controller action. */
function bind(name: keyof ItemsController, index: number, decorator: ParameterDecorator) {
  decorator(prototype, name, index);
}

action('find', Get, ':id', SendproofPreview('GET', '/items/{id}'));
bind('find', 0, Param('id'));
action('create', Post, '', UseGuards(RoleGuard), SendproofPreview('POST', '/items'));
bind('create', 0, Body());
action('remove', Delete, ':id', UseGuards(RoleGuard), SendproofPreview('DELETE', '/items/{id}'));
bind('remove', 0, Res());
action('stream', Get, 'stream/big', SendproofPreview('GET', '/items/stream/big'));
bind('stream', 0, Res());
action('hidden', Get, 'hidden/value'); // not marked with SendproofPreview, so never eligible
action('whoami', Get, 'who/am-i', SendproofPreview('GET', '/items/who/am-i'));
bind('whoami', 0, Req());
action('broken', Get, 'broken/op', SendproofPreview('GET', '/items/broken/op'));

const apps: INestApplication[] = [];
after(async () => { await Promise.all(apps.map(app => app.close())); });

interface Started { app: INestApplication; url: string }

/** Boot the controller behind `SendproofModule` on an ephemeral loopback port. */
async function start(options: NestBenchOptions = {}, configure?: (app: INestApplication) => void): Promise<Started> {
  class AppModule {}
  Module({
    controllers: [ItemsController as Type],
    imports: [SendproofModule.forRoot({ environment: 'development', previewProvider: passthrough, ...options })],
  })(AppModule);
  const app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
  configure?.(app);
  await app.listen(0, '127.0.0.1');
  apps.push(app);
  return { app, url: `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}` };
}

async function envelope(response: globalThis.Response) {
  return await response.json() as { status: number; headers: Record<string, string>; body: unknown; rolledBack: boolean };
}

test('discovered operations drive route matching and unmarked actions are refused', async () => {
  const { url } = await start();
  const matched = await fetch(`${url}/sendproof/_preview/items/42`, { headers: rollback });
  assert.equal(matched.status, 200);
  assert.equal(matched.headers.get('preference-applied'), 'tx=rollback');
  const preview = await envelope(matched);
  assert.deepEqual(preview.body, { id: '42' });
  assert.equal(preview.rolledBack, true);

  assert.equal((await fetch(`${url}/sendproof/_preview/items/hidden/value`, { headers: rollback })).status, 409,
    'a controller action without @SendproofPreview is not eligible');
  assert.equal((await fetch(`${url}/sendproof/_preview/nothing`, { headers: rollback })).status, 409);
  assert.equal((await fetch(`${url}/sendproof/_preview/items/42`, { method: 'DELETE', headers: { ...rollback, 'X-Role': 'admin' } })).status, 200);
  assert.equal((await fetch(`${url}/sendproof/_preview/items/42`, { method: 'PUT', headers: rollback })).status, 409,
    'a method with no matching action is unavailable');
});

test('SendproofPreview rejects malformed declarations', () => {
  for (const [method, path] of [['TRACE', '/items'], ['GET', 'items'], ['GET', '//items'], ['GET', '/items?x=1'], ['GET', '/items#x'], ['GET', '/a\\b']] as const) {
    assert.throws(() => SendproofPreview(method, path), /HTTP method and the workbench-relative/, `${method} ${path}`);
  }
  assert.doesNotThrow(() => SendproofPreview('patch', '/items/{id}'));
});

test('native Nest guards decide Preview and run on the rewritten request', async () => {
  const { url } = await start();
  calls.create = 0;
  const preview = (role?: string) => fetch(`${url}/sendproof/_preview/items`, {
    method: 'POST', body: JSON.stringify({ name: 'widget' }),
    headers: { ...jsonHeaders, ...rollback, ...(role ? { 'X-Role': role } : {}) },
  });

  assert.equal((await preview()).status, 401);
  assert.equal((await preview('viewer')).status, 403);
  assert.equal(calls.create, 0, 'a rejected guard must stop the controller action');
  const allowed = await preview('admin');
  assert.equal(allowed.status, 200);
  assert.equal(calls.create, 1);

  const sent = await fetch(`${url}/items`, { method: 'POST', body: '{}', headers: { ...jsonHeaders, 'X-Role': 'viewer' } });
  assert.equal(sent.status, 403);
  assert.equal(calls.create, 1);
});

test('JSON request bodies reach the action in Preview and in an observed Send', async () => {
  const { url } = await start({
    resolveIdentity: () => ({ name: 'Tester', role: 'admin', subject: 'tester@example.test', scheme: 'unit' }),
  });
  const body = JSON.stringify({ name: 'widget' });
  const headers = { ...jsonHeaders, 'X-Role': 'admin' };

  const previewed = await envelope(await fetch(`${url}/sendproof/_preview/items`, { method: 'POST', body, headers: { ...headers, ...rollback } }));
  assert.equal(previewed.status, 201);
  assert.deepEqual(previewed.body, { created: 'widget' });

  const sent = await fetch(`${url}/items`, { method: 'POST', body, headers: { ...headers, Prefer: 'trace' } });
  assert.equal(sent.status, 201);
  assert.deepEqual(await sent.json(), { created: 'widget' });
  const trace = sent.headers.get('x-sendproof-trace');
  assert(trace, 'an authenticated observed Send returns a trace id');
  assert.equal((await fetch(`${url}/sendproof/_api/traces/${trace}`)).status, 200);

  const plain = await fetch(`${url}/items`, { method: 'POST', body, headers });
  assert.equal(plain.status, 201);
  assert.equal(plain.headers.get('x-sendproof-trace'), null, 'no trace without Prefer: trace');
});

test('application middleware runs again when Preview re-enters the pipeline', async () => {
  let runs = 0;
  const { url } = await start({}, app => {
    app.use((req: Request & { actor?: string }, _res: Response, next: NextFunction) => {
      runs++;
      req.actor = String(req.headers['x-actor'] ?? 'anonymous');
      next();
    });
  });

  const sent = await fetch(`${url}/items/who/am-i`, { headers: { 'X-Actor': 'alice' } });
  assert.deepEqual(await sent.json(), { actor: 'alice' });
  assert.equal(runs, 1);

  runs = 0;
  const previewed = await envelope(await fetch(`${url}/sendproof/_preview/items/who/am-i`, { headers: { ...rollback, 'X-Actor': 'alice' } }));
  assert.deepEqual(previewed.body, { actor: 'alice' }, 'middleware state reaches the previewed action');
  assert.equal(runs, 2, 'once for the workbench request and once for the in-process dispatch');
});

test('options control availability, discovery and validation', async () => {
  const disabled = await start({ environment: 'production' });
  assert.equal((await fetch(`${disabled.url}/sendproof/`)).status, 404);

  const { url } = await start({ apiName: 'Unit API', database: 'Test DB' });
  const capabilities = await (await fetch(`${url}/sendproof/_api/capabilities`)).json() as {
    apiName: string; database: string; openApiUrl: string; observedSend: boolean; previewOperations: { method: string; path: string }[];
  };
  assert.equal(capabilities.apiName, 'Unit API');
  assert.equal(capabilities.database, 'Test DB');
  assert.equal(capabilities.openApiUrl, '/api-json', 'the Swagger JSON route is the default document');
  assert.equal(capabilities.observedSend, true);
  assert.deepEqual(capabilities.previewOperations.map(({ method, path }) => `${method} ${path}`).sort(), [
    'DELETE /items/{id}', 'GET /items/broken/op', 'GET /items/stream/big', 'GET /items/who/am-i', 'GET /items/{id}', 'POST /items',
  ]);

  const custom = await start({ openApiUrl: '/docs/openapi.json', previewProvider: undefined });
  const quiet = await (await fetch(`${custom.url}/sendproof/_api/capabilities`)).json() as {
    openApiUrl: string; previewOperations: unknown[]; observedSend: boolean;
  };
  assert.equal(quiet.openApiUrl, '/docs/openapi.json');
  assert.deepEqual(quiet.previewOperations, []);
  assert.equal(quiet.observedSend, false);
  assert.equal((await fetch(`${custom.url}/sendproof/_preview/items/1`, { headers: rollback })).status, 503);

  await assert.rejects(start({ openApiUrl: 'https://example.test/openapi.json' }), /same-origin/);
  await assert.rejects(start({ maxResponseBytes: 0 }), /positive integers/);
});

test('Preview insists on the rollback preference, the same origin and authorization', async () => {
  const { url } = await start({ authorize: ({ headers }) => headers['x-allowed'] === 'yes' });
  const target = `${url}/sendproof/_preview/items/1`;
  const allowed = { 'X-Allowed': 'yes' };

  assert.equal((await fetch(target, { headers: rollback })).status, 401, 'workbench access is denied');
  assert.equal((await fetch(target, { headers: allowed })).status, 400, 'the preference is required');
  assert.equal((await fetch(target, { headers: { ...allowed, ...rollback, Origin: 'http://evil.test' } })).status, 403);
  assert.equal((await fetch(target, { headers: { ...allowed, ...rollback, 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await fetch(target, { headers: { ...allowed, ...rollback } })).status, 200);
  assert.equal((await fetch(`${url}/sendproof/_preview/sendproof/x`, { headers: { ...allowed, ...rollback } })).status, 400,
    'the workbench itself cannot be a preview target');
});

test('a global prefix needs a matching basePath and prefixes every discovered URL', async () => {
  const { url } = await start({ basePath: '/v1', openApiUrl: '/api-json', documents: [{ name: 'Guide', url: '/guide' }] },
    app => app.setGlobalPrefix('v1'));

  const capabilities = await (await fetch(`${url}/v1/sendproof/_api/capabilities`)).json() as {
    openApiUrl: string; documents: { url: string }[]; previewOperations: { path: string }[];
  };
  assert.equal(capabilities.openApiUrl, '/v1/api-json');
  assert.equal(capabilities.documents[0]?.url, '/v1/guide');
  assert(capabilities.previewOperations.some(({ path }) => path === '/items/{id}'), 'operation paths stay prefix-free');
  assert.equal((await fetch(`${url}/v1/sendproof`, { redirect: 'manual' })).headers.get('location'), '/v1/sendproof/');
  const index = await fetch(`${url}/v1/sendproof/`);
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type') ?? '', /text\/html/);

  const previewed = await fetch(`${url}/v1/sendproof/_preview/items/9`, { headers: rollback });
  assert.equal(previewed.status, 200);
  assert.deepEqual((await envelope(previewed)).body, { id: '9' });

  for (const basePath of ['/v1/', 'v1', '/a/../b', '/a//b']) {
    await assert.rejects(start({ basePath }), /literal NestJS prefix/, basePath);
  }
});

test('responses over the capture limit are refused and a limit-sized response passes', async () => {
  const small = await start({ maxResponseBytes: 16 });
  assert.equal((await fetch(`${small.url}/sendproof/_preview/items/stream/big`, { headers: rollback })).status, 413);
  const exact = await start({ maxResponseBytes: 32 });
  assert.equal((await fetch(`${exact.url}/sendproof/_preview/items/stream/big`, { headers: rollback })).status, 200);
});

test('action failures are reported without leaking details', async () => {
  const { url } = await start();
  const broken = await fetch(`${url}/sendproof/_preview/items/broken/op`, { headers: rollback });
  assert.equal(broken.status, 500);
  assert(!(await broken.text()).includes('secret detail'));
});
