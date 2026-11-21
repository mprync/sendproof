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
