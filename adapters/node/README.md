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

MongoDB, Redis, DynamoDB, Cassandra, Elasticsearch, OpenSearch, Cosmos DB and Firestore are covered only through the clients you hook. [Data stores in the Node binding](data-stores.md) covers setup, the `preview: false` mark and what each store does in a Preview.
