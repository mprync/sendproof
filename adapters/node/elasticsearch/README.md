# @sendproof/elasticsearch

Sendproof write guard for Elasticsearch 8 and OpenSearch 2. `elasticsearchStore(client)` and `opensearchStore(client)` hook the client's transport in place: in a Preview, reads run (a `POST` search included) and the first write is refused before a connection is chosen, and the Preview answers 409.

```ts
import { Client } from '@opensearch-project/opensearch';
import { opensearchStore } from '@sendproof/elasticsearch';

const search = opensearchStore(new Client({ node: url }), { name: 'search' });
sendproof({ previewProvider, dataStores: [search] });
```

Only the hooked client and its `child()` clients are covered. See [Data stores in the Node binding](../data-stores.md) for setup, the `preview: false` mark, limits and redaction.
