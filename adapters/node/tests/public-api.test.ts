import { expectTypeOf } from 'expect-type';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { Redis } from 'ioredis';
import { MongoClient } from 'mongodb';
import type { DataStore } from '@sendproof/core';
import { dynamoStore } from '@sendproof/dynamodb';
import { mongoStore } from '@sendproof/mongodb';
import { redisStore } from '@sendproof/redis';
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
import { Capture, createBench, currentCapture } from '@sendproof/core';
import type { CaptureRecorder, PreviewProvider } from '@sendproof/core';
import { drizzlePreview } from '@sendproof/drizzle';
import { sendproof as expressBench } from '@sendproof/express';
import { sendproof as fastifyBench } from '@sendproof/fastify';
import { sendproof as honoBench } from '@sendproof/hono';
import { KnexPreview } from '@sendproof/knex';
import { SendproofModule, SendproofPreview } from '@sendproof/nestjs';
import { PrismaPreview } from '@sendproof/prisma';
import { SQLiteDatabase } from '@sendproof/sqlite';
import { TypeOrmPreview } from '@sendproof/typeorm';

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
fastify.sendproof.operation('POST', '/items', { handler: async () => ({ id: 1 }) });
// @ts-expect-error OpenAPI paths are strings.
fastify.sendproof.operation('POST', 10, async () => ({}));

const hono = honoBench({ previewProvider: sqlite, basePath: '/tenant' });
new Hono().route('/tenant', hono);
hono.operation('POST', '/items', context => context.json({ id: 1 }));
expectTypeOf(SendproofModule.forRoot({ previewProvider: sqlite })).toEqualTypeOf<DynamicModule>();
expectTypeOf(SendproofPreview('POST', '/items')).toEqualTypeOf<MethodDecorator>();

// Data stores: one registration per store, and preview:false marks in every framework.

const catalog = mongoStore(new MongoClient('mongodb://localhost/catalog'), { name: 'catalog' });
expectTypeOf(catalog.client).toEqualTypeOf<MongoClient>();
const cache = redisStore(new Redis({ lazyConnect: true }), { name: 'cache', treatAsRead: ['MYMODULE.GET'] });
expectTypeOf(cache.client).toEqualTypeOf<Redis>();
const orders = dynamoStore(new DynamoDBClient({}));
expectTypeOf(orders).toMatchTypeOf<DataStore>();
const withStores = expressBench({ previewProvider: sqlite, dataStores: [catalog, cache, orders] });
withStores.unavailable('DELETE', '/sessions/{id}', { reason: 'Clears the Redis session', stores: ['redis'] }, (_request, response) => { response.end(); });
// @ts-expect-error The preview:false mark takes its options before the handlers.
withStores.unavailable('DELETE', '/sessions/{id}', (_request: Request, response: express.Response) => { response.end(); });
fastify.sendproof.unavailable('DELETE', '/sessions/{id}', { stores: ['redis'] }, async () => ({}));
hono.unavailable('DELETE', '/sessions/{id}', { reason: 'Clears the Redis session' }, context => context.body(null, 204));
expectTypeOf(SendproofPreview('DELETE', '/sessions/{id}', { enabled: false, reason: 'Clears the Redis session' })).toEqualTypeOf<MethodDecorator>();
