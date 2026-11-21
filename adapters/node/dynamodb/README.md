# @sendproof/dynamodb

Sendproof write guard for DynamoDB. `dynamoStore(client)` adds an `initialize`-step middleware to an AWS SDK v3 `DynamoDBClient` (and any `DynamoDBDocumentClient` made from it): in a Preview, reads run and the first write is refused before the request is signed, and the Preview answers 409.

```ts
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { dynamoStore } from '@sendproof/dynamodb';

const orders = dynamoStore(new DynamoDBClient({}), { name: 'orders' });
sendproof({ previewProvider, dataStores: [orders] });
```

Only hooked clients are covered. See [Data stores in the Node binding](../data-stores.md) for setup, the `preview: false` mark, limits and redaction.
