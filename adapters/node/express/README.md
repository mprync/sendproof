# @sendproof/express

Mount it in Express 5 before the routes you want to exercise. The middleware provides the UI and discovery at `/sendproof/`. It reads the application's existing `/openapi.json` by default.

```js
import express from 'express';
import { sendproof } from '@sendproof/express';

const app = express();
app.use(express.json());
app.use(loadSession);

const bench = sendproof({
  environment: 'development',
  previewProvider: database,
  resolveIdentity: ({ raw: request }) => request.user ?? null,
  authorize: (_request, identity) => Boolean(identity),
});
app.use(bench);
bench.operation('POST', '/items', requireEditor, createItem);
```

`operation` registers the real Express handlers in the same router for Send and Preview. Put route-specific auth in that handler chain. Mount the middleware on the application or inside a mounted router. Body parsing and shared session middleware go before Sendproof. For observed Send, return `subject` and optionally `scheme` from `resolveIdentity`.

Use a transaction-aware provider such as [`@sendproof/sqlite`](../sqlite). Preview handlers should await all database writes and return a buffered response. Place external effects behind [the core recorder](../core).

## TypeScript

The package is written in strict TypeScript (`src/`) and ships generated declarations. It exports `sendproof`, `SendproofMiddleware` and `ExpressBenchOptions`; `resolveIdentity`, `authorize` and the other callbacks receive the Express `Request` as `raw`.

## Behavior

- **Routing.** `operation(method, '/items/{id}', ...handlers)` accepts only plain OpenAPI templates (`{name}` parameters, no wildcards, regex groups or dot segments, and nothing under `/sendproof`). Only the registered method and path run in Preview; any other target returns 409.
- **Path base.** Mount the middleware on the application or on a router mounted under a prefix such as `/tenant`. Discovery URLs, the `/sendproof` redirect and the preview target all follow `req.baseUrl`.
- **Authorization.** `authorize` guards the workbench and Preview. Route middleware in the handler chain also runs inside Preview, and its 401 or 403 is reported as `Preview access denied.`
- **Size cap.** Preview buffers at most `maxResponseBytes` (1 MiB by default). A streaming handler that passes the cap receives a `close` event and the caller gets 413.
- **Errors.** An error that reaches the preview router's `next()` returns a generic 500 problem, rolls the write back and is reported through `onError`. The error handler of your application is not used for Preview.

## Tests

`tests/express.test.mts` has 13 tests that start real Express apps on a loopback socket with a SQLite provider: rollback and change capture, route parameters and methods, unregistered routes, path base, authorization, request validation, unsafe registrations, streaming caps, failures, header filtering, observed Send traces, and assets with environment gating. The conformance fixture passes the standard and alternate scenarios against the compiled package.

