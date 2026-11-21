# Test Bench for Fastify

Install `@test-bench/fastify`, `@test-bench/core`, and a preview provider such as `@test-bench/sqlite` in a Fastify 5 application. Register the workbench in the Fastify scope that contains your routes, before those routes. The optional Fastify prefix is reflected in discovery and preview URLs.

```js
import Fastify from 'fastify';
import { testBench } from '@test-bench/fastify';

const app = Fastify();
await app.register(testBench, {
  apiName: 'Inventory',
  openApiUrl: '/openapi.json',
  previewProvider, // Transaction provider for the database used by the handlers
  resolveIdentity: ({ raw }) => raw.user ?? null,
  authorize: (_request, identity) => Boolean(identity),
});

app.testBench.operation('POST', '/items', {
  preHandler: requireEditor,
  async handler(request, reply) {
    const item = await createItem(request.body);
    return reply.code(201).send(item);
  },
});
```

`operation` registers the real Fastify route using an OpenAPI path template; its handler and normal Fastify hooks run for both Send and Preview. Only registered operations are eligible for preview or observed Send. Use a preview provider that actually encloses all database writes in a rollback transaction. Resolve identity and enforce authorization on every request, including inside application routes. Effects outside that transaction must be suppressed or captured by the host during preview.

Test Bench is enabled in the `development` environment by default. Set `environment` and `environments` to change when it is available. The workbench dispatches requests in-process and limits response capture to `maxResponseBytes` (1 MiB by default). See the [protocol](../../../spec/README.md) and [shared Node options](../core/src/types.ts).

## TypeScript

The plugin is written in strict TypeScript (`src/`) and ships generated declarations. It exports `testBench`, `TestBench`, `OperationRoute` and `FastifyBenchOptions`, and augments `FastifyInstance` with `testBench`. Request callbacks receive the Fastify request as `raw`.

## Behavior

- **Routing.** `operation(method, '/items/{id}', route)` accepts only plain OpenAPI templates (`{name}` parameters, no wildcards, regex groups or dot segments, and nothing under `/bench`). Only registered routes run in Preview; any other target returns 409. Register operations before the instance is ready.
- **Prefix.** Register the plugin in a prefixed scope and discovery URLs, the `/bench` redirect and the preview target include the prefix.
- **Authorization.** `authorize` guards the workbench and Preview. Route hooks (`onRequest`, `preHandler`) and your application's own hooks run inside Preview, and a 401 or 403 from them is reported as `Preview access denied.`
- **Validation.** Fastify schema validation runs on the rewritten request. A 400 from it is the operation's result, not a workbench failure.
- **Size cap.** Preview buffers at most `maxResponseBytes` (1 MiB by default). A response stream that passes the cap is destroyed and the caller gets 413.
- **Errors.** Fastify turns a handler error into a 500 response, so Preview returns a generic 500 problem and rolls the write back. A failure of the provider itself is reported through `onError`.

## Tests

`tests/fastify.test.mts` has 15 tests. Fourteen run through `app.inject` and one uses a loopback socket to send an unnormalised path. They cover rollback and change capture, route parameters and methods, unregistered routes, prefix, authorization, schema validation, request validation, unsafe registrations, streaming caps, failures, header filtering, observed Send traces, and assets with environment gating. The conformance fixture passes the standard and alternate scenarios against the compiled package.

