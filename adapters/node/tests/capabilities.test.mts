// Capabilities `binding` and `database.system` (spec/capabilities.schema.json): each framework
// package names itself, and each SQL provider names its database system, so the workbench writes
// the `preview: false` snippet in the host's idiom and shows the right database mark.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import express from 'express';
import Fastify from 'fastify';
import { Hono } from 'hono';
import knex from 'knex';
import { DataSource } from 'typeorm';
import { createBench } from '@sendproof/core';
import type { PreviewProvider } from '@sendproof/core';
import { drizzlePreview } from '@sendproof/drizzle';
import { sendproof as expressBench } from '@sendproof/express';
import { sendproof as fastifyBench } from '@sendproof/fastify';
import { sendproof as honoBench } from '@sendproof/hono';
import { KnexPreview } from '@sendproof/knex';
import { SendproofModule } from '@sendproof/nestjs';
import { SQLiteDatabase } from '@sendproof/sqlite';
import { TypeOrmPreview } from '@sendproof/typeorm';

const options = { environment: 'development', database: 'Inventory' } as const;
const passthrough: PreviewProvider = { preview: dispatch => dispatch() };
const capabilitiesPath = '/sendproof/_api/capabilities';

/** Capabilities straight from the core, for a provider. */
async function discover(previewProvider?: PreviewProvider, database: string | null = 'Inventory') {
  const bench = createBench({ environment: 'development', database, ...(previewProvider ? { previewProvider } : {}) });
  const response = await bench.lookup({ method: 'GET', pathname: capabilitiesPath, headers: {}, raw: undefined } as never);
  return JSON.parse((response as { body: Buffer }).body.toString());
}

test('each framework package reports its binding', async t => {
  const expressApp = express().use(expressBench({ ...options, previewProvider: passthrough }));
  const server = await new Promise<import('node:http').Server>(resolve => { const s = expressApp.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => server.close());
  const fromExpress = await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${capabilitiesPath}`)).json();

  const fastify = Fastify();
  await fastify.register(fastifyBench, { ...options, previewProvider: passthrough });
  t.after(() => fastify.close());
  const fromFastify = (await fastify.inject({ url: capabilitiesPath })).json();

  const hono = new Hono().route('/', honoBench({ ...options, previewProvider: passthrough }));
  const fromHono = await (await hono.request(capabilitiesPath)).json();

  class AppModule {}
  Module({ imports: [SendproofModule.forRoot({ ...options, previewProvider: passthrough })] })(AppModule);
  const nest = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
  await nest.listen(0, '127.0.0.1');
  t.after(() => nest.close());
  const fromNest = await (await fetch(`http://127.0.0.1:${(nest.getHttpServer().address() as AddressInfo).port}${capabilitiesPath}`)).json();

  assert.deepEqual([fromExpress, fromFastify, fromHono, fromNest].map(capabilities => capabilities.binding), [
    { language: 'node', framework: 'Express' }, { language: 'node', framework: 'Fastify' },
    { language: 'node', framework: 'Hono' }, { language: 'node', framework: 'NestJS' },
  ]);
  assert.equal((await discover()).binding, undefined, 'The core alone names no framework');
});

test('discovery reports the SQL provider id as database.system', async t => {
  const sqlite = new SQLiteDatabase(':memory:');
  t.after(() => sqlite.close());
  assert.deepEqual((await discover(sqlite)).database, { name: 'Inventory', system: 'sqlite' });
  assert.deepEqual((await discover(sqlite, null)).database, { name: null, system: 'sqlite' });
  assert.equal(drizzlePreview(sqlite).system, 'sqlite');

  const systems: string[] = [];
  for (const client of ['pg', 'mysql2', 'mssql']) {
    const database = knex({ client });
    t.after(() => database.destroy());
    systems.push(String(new KnexPreview(database).system));
  }
  assert.deepEqual(systems, ['postgresql', 'mysql', 'mssql']);
  const types = ['postgres', 'mysql', 'mariadb', 'better-sqlite3'] as const;
  assert.deepEqual(types.map(type => new TypeOrmPreview(new DataSource({ type, database: ':memory:' } as never)).system), ['postgresql', 'mysql', 'mariadb', 'sqlite']);

  // A provider that names no system, or an invalid one, keeps the plain label.
  assert.equal((await discover(passthrough)).database, 'Inventory');
  assert.equal((await discover({ ...passthrough, system: 'Postgres://host' } as PreviewProvider)).database, 'Inventory');
  assert.equal((await discover(undefined, null)).database, null);
});
