# @sendproof/hono

Mount Sendproof in a Node-hosted Hono application and explicitly register the operations that may run in a rollback preview. Each registered operation uses the same Hono handlers for normal requests and internal preview dispatch.

```js
import { Hono } from 'hono';
import { sendproof } from '@sendproof/hono';

const app = new Hono();
const bench = sendproof({
  environment: 'development',
  openApiUrl: '/openapi.json',
  previewProvider, // transaction provider for the database used by the handlers
  resolveIdentity: ({ raw: c }) => currentUser(c),
  authorize: (_request, identity) => Boolean(identity),
});
bench.operation('POST', '/items', authenticate, createItem);
app.route('/', bench);
```

For a mount at `/tenant`, pass `basePath: '/tenant'` and mount with `app.route('/tenant', bench)`. Configure a preview provider that starts a transaction on the connection used by the handlers and resolves only after rollback; `@sendproof/sqlite` supplies one for SQLite. Authentication and authorization handlers must be included in each registered operation. Workbench access can be restricted with `authorize`; a stable identity `subject` and `scheme` enable owner-scoped observed-send traces. Sendproof is enabled only in development by default. See the shared protocol and core options for capture limits and other configuration.

Preview dispatch stays inside the process and reads response streams only up to `maxResponseBytes`. Avoid handlers that rely on state set by parent middleware: register required middleware with the operation so it runs during both Send and Preview.

## Types and handlers

The package is written in strict TypeScript and ships its declarations. `operation()` accepts any Hono handler or middleware (`OperationHandler<E>`), so `bench.operation('GET', '/items/{id}', c => c.json(…))` and typed `Hono<{ Variables: … }>` environments both compile. A basePath is validated at creation: it must be an absolute literal path without a trailing slash, `.` or `..` segments.

## Development

Sources live in `src/` (`index.ts` public API, `paths.ts` template and prefix validation, `response.ts` fetch/transport conversion). Tests are in `../tests/hono.test.mts` and run in-process through `app.request()`, with no network. They cover 11 cases: route matching, registration validation, guards, JSON bodies and observed Send, operation middleware versus parent middleware, options and validation, Preview preconditions, base path, stream cancellation at the limit, exact-limit boundary, and handler failures.
