# @sendproof/redis

Sendproof write guard for Redis. `redisStore(client)` hooks an ioredis 5 or node-redis 5 client in place: in a Preview, reads run and the first write is refused before any byte reaches Redis, and the Preview answers 409.

```ts
import { Redis } from 'ioredis';
import { redisStore } from '@sendproof/redis';

const cache = redisStore(new Redis(url), { name: 'cache' });
sendproof({ previewProvider, dataStores: [cache] });
```

Only hooked clients are covered. See [Data stores in the Node binding](../data-stores.md) for setup, the `preview: false` mark, limits and redaction.
