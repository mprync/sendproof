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
