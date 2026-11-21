# Data-store reference fixture

A tiny, dependency-free Node app that implements the [data-store routes and shared security rules](../../../../spec/conformance/fixture.md#shared-security-rules) against real MongoDB, Redis, DynamoDB, Cassandra and OpenSearch. It exists to prove the shared checks in [data-stores.mjs](../../data-stores.mjs) and [shared-rules.mjs](../../shared-rules.mjs): they pass against it, and fail against it with the guard turned off.

It is not a binding and is not published. It implements only the protocol slice those checks use: cookie sign-in, discovery, Preview, observed Send and trace reads. SQL uses `node:sqlite`; the stores use the runner's own minimal clients in [../../stores](../../stores).

## Files

| File | What it shows a binding author |
| --- | --- |
| [guard.mjs](guard.mjs) | Classification from the shared tables (all seven stores), the Preview scope with its blocked mark, the transaction-control guard, redaction, literal masking and the `Db` log entry. |
| [hooks.mjs](hooks.mjs) | One hook per store: Redis, DynamoDB, Cassandra and OpenSearch guards; MongoDB session injection, change capture and abort; and the Cosmos DB and Firestore hooks the recordings test drives. |
| [server.mjs](server.mjs) | The routes and the Preview pipeline's order: roll back, then fault, then block, then confirm. |
| [classification.test.mjs](classification.test.mjs) | The shared vectors in `spec/data-stores/classification-cases.json`, run against the reference classifier. |
| [recordings.test.mjs](recordings.test.mjs) | Replays `spec/data-stores/recordings/` through the Cosmos DB and Firestore hooks over a fake transport: writes never reach it in a Preview. |
| [negative.mjs](negative.mjs) | Runs the checks with `BENCH_REFERENCE_GUARD=off` and asserts that exactly the guard checks fail. |

## Running it

From the repository root:

```sh
docker compose -f tests/conformance/compose.yml up -d --wait mongodb redis dynamodb
docker compose -f tests/conformance/compose.yml --profile heavy-stores up -d --wait cassandra opensearch
node tests/conformance/run.mjs data-stores-reference
node --test tests/conformance/fixtures/data-stores-reference/classification.test.mjs tests/conformance/fixtures/data-stores-reference/recordings.test.mjs
node tests/conformance/fixtures/data-stores-reference/negative.mjs
docker compose -f tests/conformance/compose.yml --profile heavy-stores down -v
```

Without the heavy-stores profile, put `BENCH_STORES=mongodb,redis,dynamodb` in front of the `run.mjs` and `negative.mjs` commands; the Cassandra and OpenSearch checks are then reported as skipped.

The runner creates a fresh MongoDB database, Redis key prefix, DynamoDB table, Cassandra keyspace and OpenSearch index for each run and removes them afterwards.

## Simplifications

- One request runs at a time, because the fixture shares one SQLite connection.
- MongoDB before images come from the committed view with read concern `majority`, which the spec allows when the driver doesn't expose the transaction's start time.
- Cassandra runs without authentication and OpenSearch without its security plugin, so neither has a credential to keep out of captures; their checks prove values are masked in `Db` entries instead.
- Only the admin identity exists; viewer and persona checks belong to the standard suite, which this fixture doesn't run.
