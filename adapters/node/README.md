# Sendproof for Node.js

Serve the shared workbench at `/sendproof/` in an API that already exposes OpenAPI. Run Preview for explicitly registered operations with a rollback provider, or let Send execute the API normally.

| Package | Purpose |
| --- | --- |
| [`@sendproof/core`](core) | Protocol, embedded UI, request-scoped capture and owner-bound traces |
| [`@sendproof/express`](express) | Express middleware and operation registration |
| [`@sendproof/fastify`](fastify) | Fastify route integration |
| [`@sendproof/hono`](hono) | Hono router for Node-hosted APIs |
| [`@sendproof/nestjs`](nestjs) | Nest module for the Express HTTP adapter |
| [`@sendproof/sqlite`](sqlite) | SQLite transaction provider and row capture |
| [`@sendproof/drizzle`](drizzle) | Drizzle query builder enlistment and automatic row capture |
| [`@sendproof/knex`](knex) | Knex transaction enlistment and row capture |
| [`@sendproof/typeorm`](typeorm) | TypeORM manager enlistment and row capture |
| [`@sendproof/prisma`](prisma) | Prisma driver-acknowledged rollback and row capture |
| [`@sendproof/mongodb`](mongodb) | MongoDB Preview for the driver and Mongoose, with document changes |
| [`@sendproof/redis`](redis) | Redis write guard for ioredis and node-redis |
| [`@sendproof/dynamodb`](dynamodb) | DynamoDB write guard for the AWS SDK v3 clients |
| [`@sendproof/cassandra`](cassandra) | Cassandra and ScyllaDB write guard for `cassandra-driver` 4 |
| [`@sendproof/elasticsearch`](elasticsearch) | Elasticsearch 8 and OpenSearch 2 write guard |
| [`@sendproof/cosmosdb`](cosmosdb) | Azure Cosmos DB for NoSQL write guard for `@azure/cosmos` 4.10 |
| [`@sendproof/firestore`](firestore) | Google Cloud Firestore write guard for `@google-cloud/firestore` 7 |

Run a local fixture with Node 22.18 or newer.

```sh
npm ci --prefix adapters/node && npm run build --prefix adapters/node && node adapters/node/examples/fixture.mjs
```

Open `http://127.0.0.1:5351/sendproof/`. Sign in as `admin@example.test` with `bench-fixture`. The fixture starts with an empty in-memory database. [The conformance manifest](../../tests/conformance/bindings.json) lists the other fixture launch commands.

The packages build from strict TypeScript in `src/` to ESM and generated declarations in `dist/`. From the repository root, `npm run build:fixtures --prefix adapters/node` also generates the Prisma clients for the test fixtures. Run `npm run typecheck --prefix adapters/node` to check the public types and `npm test --prefix adapters/node` to exercise the packages. The [database guide](../../docs/bindings/databases.md) shows which database combinations passed the shared matrix and how to start their local services.

Configure `NODE_ENV=development` or the equivalent `environment` option to enable the workbench with the default environment allowlist. Preview uses application-managed identity and authorization, and the provider must cover all writes. Use [the Node core recorder](core) to hold external effects until Send.

## Preview sessions and journeys

Sessions are enabled when the configured Preview provider and every rollback-capable store can hold transactions across requests. Set `previewSessions: false` to disable them, or pass `previewSessions: { idleTimeoutSeconds: 300, maxLifetimeSeconds: 1800 }` to tune the defaults. Discovery reports `previewSessions` for the current host. Sessions are bound to one process and a stable caller subject, with limits of four per caller and sixteen per host. Sign in before opening a session and use sticky routing on multi-instance hosts.

Define journeys in TypeScript with `defineJourney`. Pass the same OpenAPI object your application serves at `openApiUrl` (by default `/openapi.json`). At startup Sendproof checks the operation IDs and input and step references, then publishes the Arazzo 1.1 and expectations documents with `source: "code"`. Invalid definitions stop startup in Development. In other enabled environments, Sendproof logs and skips them.

```ts
import { defineJourney } from '@sendproof/core';
import { sendproof } from '@sendproof/express';

const lookup = defineJourney({
  id: 'itemLookup',
  name: 'Look up an item',
  inputs: { type: 'object', properties: { id: { type: 'string', default: 'demo-item' } } },
}, ({ input, step }) => {
  step<{ path: { id: string } }>('getItem', 'getItem')
    .set('path', 'id', input('id'))
    .succeedsWith(200)
    .expectWrites({ writes: [] });
});

const bench = sendproof({
  openApiDocument,
  previewProvider,
  journeys: [lookup],
});
```

Bind request parameters with `set` and JSON bodies with `body`. Use the reference returned by `output<T>(name, expression)` in a later step. To assert writes, pass store operations and expected values to `expectWrites`. The `match` helpers describe generated values, patterns and before/after changes. Use `sendOnly` to record why a journey requires Send.

The same `journeys` array accepts Arazzo 1.1 file URLs. Pair each file with a sibling `<name>.expect.json` and give its Arazzo source the application-relative OpenAPI URL. Discovery adds the application mount to both code and file URLs.

In CI, start the API with representative test data and run its published journeys with the [Sendproof CLI](cli). The CLI defaults to Preview, requires Preview sessions for that mode, and returns a failing exit code if a journey fails.

```sh
npx @sendproof/cli journeys run itemLookup --api http://127.0.0.1:5351 --junit sendproof.xml
```

Pass the API's credentials with options such as `--sign-in` and the `SENDPROOF_PASSWORD` environment variable. For a Send-only journey, use `--mode send --yes --allow-send` against your development test API.

Use these options with Express or Hono `sendproof()`, the Fastify plugin, or `SendproofModule.forRoot()` in NestJS. In Hono, pass `application: app` when session GETs need routes declared on the parent app. On shutdown, await `bench.close()` for Express and Hono before disposing of database clients. Fastify and NestJS close the sessions through their application shutdown hooks.

Session GETs see uncommitted changes from prior steps. A read marked `preview: false` stays refused. See [store and driver limits](data-stores.md#preview-sessions).

MongoDB, Redis, DynamoDB, Cassandra, Elasticsearch, OpenSearch, Cosmos DB and Firestore are covered only through the clients you hook. [Data stores in the Node binding](data-stores.md) covers setup, the `preview: false` mark and what each store does in a Preview.
