# Acme Treasury API demo

A believable corporate-treasury API for judging Sendproof with realistic data: 40 operations over accounts, balances, counterparties, payments with four-eyes approval, FX deals, bank statements and users.

Run `dotnet run --project examples/TreasuryApi` from the repository root, then open <http://localhost:5080/sendproof>. The launch profile selects Development. The OpenAPI 3.1 document is generated at `/openapi/v1.json` from the actual endpoints, contracts and their XML comments.

## Sign in

Every seeded user has the password `Demo123!`. In Development the persona picker switches user without a password.

| User | Role | Use it to |
| --- | --- | --- |
| `ada.admin@acme.dev` | `admin` | Everything: accounts, user roles |
| `ben.approver@acme.dev` | `payments.approve` | Approve payments created by someone else |
| `devi.approver@acme.dev` | `payments.approve` | Second approver, so four-eyes can be demonstrated |
| `tomas.treasurer@acme.dev` | `payments.approve` | Create and submit payments |
| `cara.viewer@acme.dev` | `read-only` | See what a viewer is refused (403) |
| `ines.auditor@acme.dev`, `liam.payables@acme.dev` | `read-only` | More read-only users |
| `greta.former@acme.dev` | `read-only`, inactive | Cannot sign in with a password |

## Operations

Authentication stays at `/auth/*` (`login`, `me`, `logout`, `personas`, `personas/{email}`); everything else is under `/api/v2`. Operation IDs look like `PaymentsController.Create`.

| Tag | Operations |
| --- | --- |
| Authentication | sign in, current user, sign out, list personas, switch persona |
| Accounts | list, get, register, update (freeze), close |
| Balances | cash position, one account's balance, intraday history, and the **deprecated** `GET /accounts/{id}/balance` |
| Counterparties | list, get, add (`Iban`, `UsAch` or `Swift` bank details), update, archive |
| Payments | list, get, create, update draft, submit for approval, cancel |
| Approvals | queue, approve, reject (nobody approves their own payment) |
| FX deals | quote, book, list, get, cancel (`Spot` or `Forward`) |
| Bank statements | list, get with entries (camt.053 style), list entries |
| Users and roles | list users, get user, list roles, change a role (admin only) |

Lists take `page` and `pageSize` (1 to 100, default 25), filters, a `q` search and a `sort` such as `valueDate` or `-amount`, and return `{ items, page, pageSize, totalItems, totalPages }`. Errors are RFC 9457 problem details: 400 with an `errors` object for invalid input, 404, 409 for a state that does not allow the action, 422 for a business rule.

## Preview and Send

Creating a payment reserves funds and inserts a draft and an audit event in SQLite. The writes that matter are Preview-enabled: create payment, update, submit, cancel, approve, reject, add counterparty, update and archive counterparty, register, update and close account, book and cancel FX deal, change a role. Preview runs the real handler inside the Sendproof EF transaction and rolls it back, and shows the changes, the SQL and the notifications that would be sent: emails, queued jobs and published messages. Send commits. Notifications go to an in-memory queue; nothing is ever delivered. An optional `Idempotency-Key` header on create payment replays a previously committed identical request and rejects a different request using that key.

## Optional data stores: Redis and MongoDB

The demo also runs against the compose Redis and MongoDB, so the workbench's data-store views show real data. Both are optional: each is hooked only when its URL is set (as configuration or an environment variable), and with neither set the demo runs on SQLite alone, exactly as described above.

| Setting | Store | What it holds | In Preview |
| --- | --- | --- | --- |
| `DemoRedisUrl` | Redis (`cache`, mode `guard`) | `fx:quote:*`, each FX quote for its 30 seconds; `limits:approvals:{email}`, a per-payment approval limit per approver, read when a decision is recorded | `FxController.Quote` writes the cache, so it is listed under `previewUnavailable` ("Quotes are cached in Redis for 30 seconds.") and a Preview of it answers 409. Reads run and are logged |
| `DemoMongoUrl` | MongoDB (`treasury`, mode `preview`) | `audit_events`, one event per approve or reject; `approval_snapshots`, one document per payment with its decisions (nested, with an array) | Approve and reject write both collections inside a MongoDB transaction that is aborted, and report the document changes beside the SQL ones |

With MongoDB configured the API gains `ApprovalsController.Audit` (`GET /api/v2/approvals/{paymentId}/audit`, 41 operations in all), which reads a payment's `approval_snapshots` document. On first start the demo fills both stores from the seeded payments (an audit trail per decided payment, limits for `ben.approver`, `devi.approver` and `ada.admin`); each fills only when empty. A store that is down at start is skipped with a warning.

### Run the local demo

Start the compose services, build the release binary and start it detached from the repository root. The demo listens on <http://127.0.0.1:5189> and the workbench is at <http://127.0.0.1:5189/sendproof/>:

```sh
docker compose -f tests/conformance/compose.yml up -d --wait redis mongodb
dotnet build examples/TreasuryApi/TreasuryApi.csproj -c Release
cd examples/TreasuryApi && ASPNETCORE_ENVIRONMENT=Development \
  DemoRedisUrl='redis://:bench_redis_local@127.0.0.1:56379' \
  DemoMongoUrl='mongodb://127.0.0.1:57017/treasury?directConnection=true' \
  nohup dotnet bin/Release/net10.0/TreasuryApi.dll --urls http://127.0.0.1:5189 > /tmp/treasury-demo.log 2>&1 < /dev/null &
```

Check it with `curl http://127.0.0.1:5189/sendproof/_api/capabilities` (200, with `dataStores` listing `redis` and `mongodb`). Stop it with `pkill -f 'TreasuryApi.dll'`. Leave out the two `Demo…Url` variables to run it without the stores. The command must run from `examples/TreasuryApi`, because the database and keys sit beside the project.

## Seed data

A new database is filled once with deterministic data (a fixed random seed; dates are relative to the day it is created, so the data is always current): 8 users, 27 accounts across Acme entities in Ireland, Germany, the US, the UK, France, the Netherlands, Switzerland, Sweden and Japan, with checksum-valid IBANs and real-format BICs; 51 counterparties; about 190 payments in every status with value dates from 90 days back to 30 days ahead and an approval history; 31 FX deals; and two weeks of reconciling bank statements for the main accounts. `Operating EUR` always starts with exactly 250,000.00 available and no open payments. Existing databases are never seeded or recreated.

## Reset

On first run the example creates `treasury-demo.db` in this directory. Stop the application and delete that file (and its SQLite sidecars, if present) to reset it. Set `DemoDatabasePath` to a separate, initially nonexistent file to run an isolated instance.

Session cookies are protected with keys kept in `treasury-demo.keys/`, beside the database, so sign-in never depends on the machine-wide `~/.aspnet/DataProtection-Keys` ring. Deleting the database and that folder resets the demo. Set `DemoKeyDirectory` to use a different private, writable directory outside the web root; the browser suite puts one beside its temporary database and removes both when it finishes.

This is a local development sample, not a production identity or banking system. It has no external payment, notification, or email integration. Preview covers this one EF Core database only. Idempotency illustrates sequential retries; the example does not implement production-grade concurrent payment processing.

## Code layout

`Domain/` enums, persistence records, notification queue, IBAN and FX helpers · `Data/` the EF Core context · `Contracts/` the documented API models · `Endpoints/` one file per tag · `OpenApi/` the document, operation and schema transformers and examples · `Seed/` the demo data.

Documentation comes from XML comments (`GenerateDocumentationFile`). Two details matter for that: handler methods must be `internal` or `public`, and `AddOpenApi` must be called with a lambda, or the OpenAPI source generator skips them.

## Tests

Run the in-process SQLite and TestServer integration tests with `dotnet test examples/TreasuryApi/tests/TreasuryApi.Tests.csproj`. They cover the Preview and Send flow, the approval flow and four-eyes rule, the seed data's integrity, and that every operation, parameter and schema property in the OpenAPI document has a description. If the test runner cannot bind a loopback socket, build that project and run `dotnet examples/TreasuryApi/tests/bin/Debug/net10.0/TreasuryApi.Tests.dll` to execute the same assertions without VSTest.
