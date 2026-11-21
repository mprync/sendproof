# Test Bench for Node.js

Serve the shared workbench at `/bench/` in an API that already exposes OpenAPI. Run Preview for explicitly registered operations with a rollback provider, or let Send execute the API normally.

| Package | Purpose |
| --- | --- |
| [`@test-bench/core`](core) | Protocol, embedded UI, request-scoped capture and owner-bound traces |
| [`@test-bench/express`](express) | Express middleware and operation registration |
| [`@test-bench/fastify`](fastify) | Fastify route integration |
| [`@test-bench/hono`](hono) | Hono router for Node-hosted APIs |
| [`@test-bench/nestjs`](nestjs) | Nest module for the Express HTTP adapter |
| [`@test-bench/sqlite`](sqlite) | SQLite transaction provider and row capture |
| [`@test-bench/drizzle`](drizzle) | Drizzle query builder enlistment and automatic row capture |
| [`@test-bench/knex`](knex) | Knex transaction enlistment and row capture |
| [`@test-bench/typeorm`](typeorm) | TypeORM manager enlistment and row capture |
| [`@test-bench/prisma`](prisma) | Prisma driver-acknowledged rollback and row capture |

Run a local fixture with Node 22.18 or newer.

```sh
npm ci --prefix adapters/node && npm run build --prefix adapters/node && node adapters/node/examples/fixture.mjs
```

Open `http://127.0.0.1:5351/bench/`. Sign in as `admin@example.test` with `bench-fixture`. The fixture starts with an empty in-memory database. [The conformance manifest](../../tests/conformance/bindings.json) lists the other fixture launch commands.

The packages build from strict TypeScript in `src/` to ESM and generated declarations in `dist/`. From the repository root, `npm run build:fixtures --prefix adapters/node` also generates the Prisma clients for the test fixtures. Run `npm run typecheck --prefix adapters/node` to check the public types and `npm test --prefix adapters/node` to exercise the packages. The [database guide](../../docs/bindings/databases.md) shows which database combinations passed the shared matrix and how to start their local services.

Configure `NODE_ENV=development` or the equivalent `environment` option to enable the workbench with the default environment allowlist. Preview uses application-managed identity and authorization, and the provider must cover all writes. Use [the Node core recorder](core) to hold external effects until Send.
