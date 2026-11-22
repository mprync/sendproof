# @sendproof/cassandra

Sendproof write guard for Apache Cassandra and ScyllaDB. `cassandraStore(client)` hooks a `cassandra-driver` 4 `Client` in place: in a Preview, reads run and the first write (including every `batch`) is refused before a request is built, and the Preview answers 409.

```ts
import { Client } from 'cassandra-driver';
import { cassandraStore } from '@sendproof/cassandra';

const tickets = cassandraStore(new Client({ contactPoints, localDataCenter, keyspace }), { name: 'tickets' });
sendproof({ previewProvider, dataStores: [tickets] });
```

Only the hooked `Client` is covered. See [Data stores in the Node binding](../data-stores.md) for setup, the `preview: false` mark, limits and redaction.
