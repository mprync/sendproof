# @test-bench/core

Protocol and capture shared by the Node framework adapters. Install the framework package for your application. It depends on this package and serves the bundled assets.

Use `deliverEffect` where the application sends an email, enqueues work or makes a similar external call. It records the effect and suppresses delivery during Preview. During ordinary Send it invokes the supplied callback and, when the request is observed, records successful delivery.

```js
import { currentCapture, deliverEffect } from '@test-bench/core';

currentCapture()?.log({ level: 'Information', category: 'Items', message: 'Created an item' });
await deliverEffect({ kind: 'email', description: 'Item created', data: { subject: 'Item created' } },
  () => mailer.send(message));
```

Logs and database snapshots are request-scoped. See [the TypeScript types](src/types.ts) for option and provider contracts. The provider's `preview(dispatch)` must forward the handler's result only after the enrolled transaction has rolled back, and reject if rollback fails.

`npm pack` runs the shared asset packer and includes the generated assets and manifest. Use `npm run build --prefix adapters/node` when working from a checkout.
