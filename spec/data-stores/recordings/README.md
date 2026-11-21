# Recorded store requests

Cosmos DB and Firestore have no service in [compose.yml](../../../tests/conformance/compose.yml): the Cosmos DB emulator is large and runs on Linux x64 only, and the Firestore emulator needs a Java and gcloud toolchain. So their guard hooks are proven by unit tests that replay the requests real SDKs send, recorded here, instead of by the shared HTTP checks.

| File | Store | Recorded from |
| --- | --- | --- |
| [cosmosdb.json](cosmosdb.json) | Azure Cosmos DB for NoSQL | `@azure/cosmos` 4.10.2 |
| [firestore.json](firestore.json) | Google Cloud Firestore | `@google-cloud/firestore` 7.11.6, REST transport |

## Format

Each file holds one store's recordings:

```json
{
  "store": "cosmosdb",
  "version": 1,
  "recordedWith": { "sdk": "@azure/cosmos 4.10.2", "runtime": "Node 24.5.0", "date": "2026-11-22" },
  "recordings": [
    { "name": "create a document", "requests": [ { "…": "one entry per request the SDK sent" } ] }
  ]
}
```

A recording is one SDK call, such as "run a transactional batch". Its `requests` are every request that call put on the wire, in order, including the SDK's own metadata reads (container definitions, partition key ranges, query plans). Each request entry has:

| Store | Field | Meaning |
| --- | --- | --- |
| Cosmos DB | `http` | `{ method, path, headers, body? }`: the request on the HTTP pipeline. |
| Cosmos DB | `sdk` | `{ operationType, resourceType }` as an `@azure/cosmos` request plugin saw them. Other SDKs name the same operations in their own spelling (`OperationType.ExecuteJavaScript` in .NET and Java). |
| Cosmos DB | `expect.http`, `expect.sdk` | `{ kind, operation }` for a hook that classifies the HTTP request and for one that classifies the SDK's operation type (plus the request's trigger headers). |
| Firestore | `rest` | `{ method, path, body? }`: the REST request. `body` is the proto3 JSON form of the gRPC request message. |
| Firestore | `rpc` | The gRPC method the REST request stands for, such as `/google.firestore.v1.Firestore/Commit`. |
| Firestore | `expect` | `{ kind, operation }`. |

`kind` is `read`, `session` or `write`, and `operation` is the `db.operation.name` the Db log entry and the 409 body use, both as the store's table in [spec/data-stores](..) defines them.

Recordings never hold credentials: authorization headers and tokens, dates, activity and correlation ids, user agents and SDK capability flags are dropped. Ids and documents are made up.

## What a binding's unit test does with them

For each recording, the test installs the binding's hook on a client whose transport is a fake that records what reaches it and answers each request with a plausible reply, then, inside a Preview scope:

1. Replays each request through the hook in order: a gRPC hook gets `rpc` and the message parsed from `rest.body`; an HTTP or SDK hook gets `http` (or `sdk`).
2. For a `read` or `session` request, asserts the fake transport received it unchanged, and for a `read`, that a `Db` log entry with the expected `operation` was recorded with every literal replaced by `?`.
3. For a `write`, asserts the hook refused it with the binding's `PreviewWriteBlocked` error naming the store and `operation`, that **nothing reached the fake transport**, and that the Preview scope is marked blocked, so the Preview answers 409.
4. Outside a Preview, asserts every request reaches the transport, writes included.

Each binding also runs the same test with the hook removed and shows the write assertions fail.

The reference test is [recordings.test.mjs](../../../tests/conformance/fixtures/data-stores-reference/recordings.test.mjs).

## Adding a recording

Record from the SDK itself rather than writing requests by hand: point the SDK at a local HTTP server that logs each request and answers with a plausible reply (for Firestore, use `preferRest: true` and an auth client with a fixed token), drop the headers listed above, and add the expectation the store's table gives. A recording whose expectation disagrees with the table is a table bug or an SDK change worth a note in [spec/data-stores.md](../../data-stores.md).
