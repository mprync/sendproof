# @sendproof/cosmosdb

Sendproof write guard for Azure Cosmos DB for NoSQL. `cosmosStore(client)` adds a request plugin to an `@azure/cosmos` 4.10 `CosmosClient`: in a Preview, reads run and the first write is refused before the request is sent, and the Preview answers 409.

```ts
import { CosmosClient } from '@azure/cosmos';
import { cosmosStore } from '@sendproof/cosmosdb';

const orders = cosmosStore(new CosmosClient({ endpoint, key }), { name: 'orders' });
sendproof({ previewProvider, dataStores: [orders] });
```

Only the hooked client and the databases and containers derived from it are covered. See [Data stores in the Node binding](../data-stores.md) for setup, the `preview: false` mark, limits and redaction.
