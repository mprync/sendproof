# @sendproof/firestore

Sendproof write guard for Google Cloud Firestore. `firestoreStore(firestore)` hooks a `@google-cloud/firestore` 7 `Firestore` instance in place: in a Preview, reads run and the first write (a `Commit` with writes, `BatchWrite`, `Write`) is refused before it is sent, and the Preview answers 409.

```ts
import { Firestore } from '@google-cloud/firestore';
import { firestoreStore } from '@sendproof/firestore';

const orders = firestoreStore(new Firestore({ projectId }), { name: 'orders' });
sendproof({ previewProvider, dataStores: [orders] });
```

Only the hooked instance is covered. See [Data stores in the Node binding](../data-stores.md) for setup, the `preview: false` mark, limits and redaction.
