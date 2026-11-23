# @sendproof/mongodb

Sendproof Preview for MongoDB. On a replica set or sharded cluster, each Preview runs in one transaction that is aborted after the handler, and reports document changes. On a standalone server the store runs in guard mode: reads run and the first write blocks the Preview.

```ts
import { MongoClient } from 'mongodb';
import { mongooseStore, mongoStore } from '@sendproof/mongodb';

const catalog = mongoStore(new MongoClient(url), { name: 'catalog' }); // handlers use catalog.client
sendproof({ previewProvider, dataStores: [catalog] });

// Mongoose 8: after mongoose.connect(url, { monitorCommands: true }), before defining models
const documents = mongooseStore(mongoose, { name: 'catalog' });
```

Only hooked clients are covered. See [Data stores in the Node binding](../data-stores.md) for setup, the `preview: false` mark, limits and redaction.

Preview sessions on a replica set or sharded cluster share one uncommitted transaction. The guarded driver's collection write methods and Mongoose model writes support rewind on existing collections. Before the first write to a collection in a step, Sendproof reads its documents in the transaction. It bounds those images across the step at 1,000 documents and 16 MiB, with a 64 MiB limit for retained undo images across the session. Writes that exceed the before-image bounds are refused. If the transaction expires or complete undo images cannot be verified after dispatch, the session closes without confirming the step.
