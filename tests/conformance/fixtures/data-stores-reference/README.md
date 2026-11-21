# Data-store reference fixture

A tiny, dependency-free Node app that implements the [data-store routes and shared security rules](../../../../spec/conformance/fixture.md#shared-security-rules) against real MongoDB, Redis and DynamoDB. It exists to prove the shared checks in [data-stores.mjs](../../data-stores.mjs) and [shared-rules.mjs](../../shared-rules.mjs): they pass against it, and fail against it with the guard turned off.

It is not a binding and is not published. It implements only the protocol slice those checks use: cookie sign-in, discovery, Preview, observed Send and trace reads. SQL uses `node:sqlite`; the stores use the runner's own minimal clients in [../../stores](../../stores).

## Files

| File | What it shows a binding author |
| --- | --- |
| [guard.mjs](guard.mjs) | Classification from the shared tables, the Preview scope with its blocked mark, the transaction-control guard, redaction and the `Db` log entry. |
| [hooks.mjs](hooks.mjs) | One hook per store: Redis and DynamoDB guards, and MongoDB session injection, change capture and abort. |
| [server.mjs](server.mjs) | The routes and the Preview pipeline's order: roll back, then fault, then block, then confirm. |
| [classification.test.mjs](classification.test.mjs) | The shared vectors in `spec/data-stores/classification-cases.json`, run against the reference classifier. |
| [negative.mjs](negative.mjs) | Runs the checks with `BENCH_REFERENCE_GUARD=off` and asserts that exactly the guard checks fail. |

## Running it

From the repository root:

```sh
docker compose -f tests/conformance/compose.yml up -d --wait mongodb redis dynamodb
node tests/conformance/run.mjs data-stores-reference
node --test tests/conformance/fixtures/data-stores-reference/classification.test.mjs
node tests/conformance/fixtures/data-stores-reference/negative.mjs
docker compose -f tests/conformance/compose.yml down -v
```

The runner creates a fresh MongoDB database, Redis key prefix and DynamoDB table for each run and removes them afterwards.

## Simplifications

- One request runs at a time, because the fixture shares one SQLite connection.
- MongoDB before images come from the committed view with read concern `majority`, which the spec allows when the driver doesn't expose the transaction's start time.
- Only the admin identity exists; viewer and persona checks belong to the standard suite, which this fixture doesn't run.
