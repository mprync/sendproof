import { expectTypeOf } from 'expect-type';
import express from 'express';
import type { Request } from 'express';
import Fastify from 'fastify';
import { Hono } from 'hono';
import type { DynamicModule } from '@nestjs/common';
import type { SqlDriverAdapterFactory } from '@prisma/driver-adapter-utils';
import type { MySql2Database } from 'drizzle-orm/mysql2';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Knex } from 'knex';
import type { DataSource, EntityManager } from 'typeorm';
import { Capture, createBench, currentCapture } from '@test-bench/core';
import type { CaptureRecorder, PreviewProvider } from '@test-bench/core';
import { drizzlePreview } from '@test-bench/drizzle';
import { testBench as expressBench } from '@test-bench/express';
import { testBench as fastifyBench } from '@test-bench/fastify';
import { testBench as honoBench } from '@test-bench/hono';
import { KnexPreview } from '@test-bench/knex';
import { TestBenchModule, TestBenchPreview } from '@test-bench/nestjs';
import { PrismaPreview } from '@test-bench/prisma';
import { SQLiteDatabase } from '@test-bench/sqlite';
import { TypeOrmPreview } from '@test-bench/typeorm';

declare const knex: Knex;
declare const postgres: NodePgDatabase;
declare const mysql: MySql2Database;
declare const source: DataSource;
declare const adapter: SqlDriverAdapterFactory;
const sqlite = new SQLiteDatabase(':memory:');
expectTypeOf(sqlite).toMatchTypeOf<PreviewProvider>();
expectTypeOf(sqlite.transaction(async () => 4)).toEqualTypeOf<Promise<number>>();
expectTypeOf(drizzlePreview(sqlite)).toMatchTypeOf<PreviewProvider>();
expectTypeOf(drizzlePreview(postgres).client).toEqualTypeOf<NodePgDatabase>();
expectTypeOf(drizzlePreview(mysql).client).toEqualTypeOf<MySql2Database>();
// @ts-expect-error Drizzle capture limits are numeric.
drizzlePreview(postgres, { trackedRowLimit: '500' });
expectTypeOf(new KnexPreview(knex)).toMatchTypeOf<PreviewProvider>();
expectTypeOf(new PrismaPreview(adapter)).toMatchTypeOf<PreviewProvider>();
const typeorm = new TypeOrmPreview(source);
expectTypeOf(typeorm.run(manager => {
  expectTypeOf(manager).toEqualTypeOf<EntityManager>();
  return true;
})).toEqualTypeOf<Promise<boolean>>();

expectTypeOf(new Capture('preview')).toMatchTypeOf<CaptureRecorder>();
expectTypeOf(currentCapture()).toEqualTypeOf<CaptureRecorder | undefined>();
createBench<Request>({ resolveIdentity: ({ raw }) => {
  expectTypeOf(raw).toEqualTypeOf<Request>();
  return null;
} });
// @ts-expect-error Limits are numeric and checked at runtime.
createBench({ maxResponseBytes: '1MB' });
// @ts-expect-error Rollback providers acknowledge asynchronously and preserve the dispatch result.
createBench({ previewProvider: { preview: () => false } });

const expressApp = express();
const middleware = expressBench({ previewProvider: sqlite });
expressApp.use(middleware);
middleware.operation('GET', '/items/{id}', (request, response) => {
  expectTypeOf(request).toMatchTypeOf<Request>();
  response.json({ id: request.params.id });
});
// @ts-expect-error Express operation registration takes a request handler.
middleware.operation('POST', '/items', 123);

const fastify = Fastify();
await fastify.register(fastifyBench, { previewProvider: sqlite });
fastify.testBench.operation('POST', '/items', { handler: async () => ({ id: 1 }) });
// @ts-expect-error OpenAPI paths are strings.
fastify.testBench.operation('POST', 10, async () => ({}));

const hono = honoBench({ previewProvider: sqlite, basePath: '/tenant' });
new Hono().route('/tenant', hono);
hono.operation('POST', '/items', context => context.json({ id: 1 }));
expectTypeOf(TestBenchModule.forRoot({ previewProvider: sqlite })).toEqualTypeOf<DynamicModule>();
expectTypeOf(TestBenchPreview('POST', '/items')).toEqualTypeOf<MethodDecorator>();
