# Acme Store API demo

A believable online-store API for judging Sendproof with realistic data: 47 operations over a catalogue, stock, customers, carts, orders, payments and refunds, shipments, coupons and users (51 with MongoDB, which adds order histories and product reviews).

Run `dotnet run --project examples/StoreApi` from the repository root, then open <http://localhost:5080/sendproof>. The launch profile selects Development. The OpenAPI 3.1 document is generated at `/openapi/v1.json` from the actual endpoints, contracts and their XML comments.

## Sign in

Every seeded user has the password `Demo123!`. In Development the persona picker switches user without a password. Roles are the scopes each operation lists.

| User | Role | Use it to |
| --- | --- | --- |
| `ada.admin@acme.dev` | `admin` | Everything: products, coupons, user roles |
| `sam.support@acme.dev`, `pia.support@acme.dev` | `support` | Customers, orders, payments and refunds; order for a customer |
| `wes.warehouse@acme.dev` | `warehouse` | Stock levels, adjustments and shipments |
| `mia.customer@acme.dev` | `customer` | Shop and order as a customer (Plus tier, euros, no cart) |
| `noah.customer@acme.dev`, `priya.customer@acme.dev`, `lena.customer@acme.dev`, `omar.customer@acme.dev` | `customer` | More shoppers (US dollars, pounds, euros, Canadian dollars) with carts |
| `liam.reseller@acme.dev` | `customer` | Has used the hourly order limit in Redis, so ordering answers 429 |
| `gus.former@acme.dev` | `support`, inactive | Cannot sign in with a password |

Browsing the catalogue and reviews, and registering a customer, are **public**; every other operation is locked. A customer sees only their own customer record, cart, orders and shipments (403 otherwise).

## Operations

Authentication stays at `/auth/*` (`login`, `me`, `logout`, `personas`, `personas/{email}`); everything else is under `/api/v2` (plus the deprecated `/api/v1/products/search`). Operation IDs look like `OrdersController.Place`.

| Tag | Operations |
| --- | --- |
| Authentication | sign in, current user, sign out, list personas, switch persona |
| Catalog | list and search products (public), get a product with its variants and prices in ten currencies (public), create, update, list and create categories, and the **deprecated** v1 search |
| Inventory | stock levels, one level, adjust, movements, reservations, and the **deprecated** `GET /products/{id}/stock` |
| Customers | list, get, register (public), update, list and add addresses |
| Carts | get, add, change and remove lines (each holds stock for 15 minutes), and **quote a price** (`preview: false`, it writes Redis) |
| Orders | list, get, **place** (idempotent, multi-store), cancel (optional body), and the event history from MongoDB |
| Payments | list, get, capture an authorised payment (a bank transfer that arrived), refund (`Card`, `BankTransfer` or `GiftCard` payments) |
| Shipments | list, get, create for a paid order |
| Reviews | list, add, vote (MongoDB only; nested documents) |
| Coupons | list, a read-only check, **redeem** (counts with Redis `INCRBY`), create (`Percentage`, `FixedAmount` or `FreeShipping`) |
| Users and roles | list users, list roles, change a role (admin only) |

Lists take `page` and `pageSize` (1 to 100, default 25), filters, a `q` search and a `sort` such as `price` or `-placedAt`, and return `{ items, page, pageSize, totalItems, totalPages }`. Errors are RFC 9457 problem details: 400 with an `errors` object for invalid input (nested as `items[0].sku`), 402 for a declined payment, 404, 409 for a state that does not allow the action (out of stock, key reused, price moved), 422 for a business rule and 429 for the order limit.

What the workbench shows off, and where: ID lookups from a list operation (`x-lookup` on customers, products, orders, categories and SKUs), amount and currency pairs (`x-currency-field` on a refund amount, a product price and a coupon amount), radio groups and inline enums (shipping speed, refund reason, address kind), a `oneOf` payment method nested in the order body and a `oneOf` coupon as a whole body, nested and array models, an optional body (cancel an order), deprecated operations with their replacement, and a read-only `GET` (check a coupon).

## Preview and Send

Placing an order is the operation to try. In SQLite it inserts the order, its lines and the payment, decrements stock, writes stock movements and reservations, and audits the change. Preview runs the real handler inside the Sendproof EF transaction and rolls it back, and shows the changes grouped by store, the SQL, MongoDB, Redis and DynamoDB commands with their timings, the log lines and the side effects it **holds back**: the confirmation email, the fulfilment webhook, the pick-list job and a published message. Send commits. Side effects go to an in-memory queue; nothing is ever delivered. An optional `Idempotency-Key` header on place order replays a previously committed identical request and rejects a different request using that key.

The writes that matter are Preview-enabled: create product, update product, create category, adjust stock, register customer, update customer, add address, add, change and remove cart lines, place and cancel order, create shipment, refund, create and redeem coupon, add review, vote, and change a role.

## Optional data stores: Redis, MongoDB and DynamoDB

The demo also runs against the compose Redis, MongoDB and DynamoDB Local, so the workbench's data-store views show real data. Each is optional: hooked only when its URL is set (as configuration or an environment variable), and with none set the demo runs on SQLite alone, exactly as described above.

| Setting | Store | What it holds | In Preview |
| --- | --- | --- | --- |
| `DemoRedisUrl` | Redis (`cache`, mode `guard`) | `quote:{id}`, each price quote for 15 minutes; `ratelimit:orders:{email}`, orders placed this hour; `coupon:redemptions:{code}`, how often each coupon was redeemed | Placing an order **reads** the rate limit and the quote (allowed). `CartsController.Quote` writes the cache, so it is `preview: false` (409 on Preview). `CouponsController.Redeem` runs `INCRBY`, which the write guard stops with "Preview stopped before writing to Redis" |
| `DemoMongoUrl` | MongoDB (`store`, mode `preview`) | `order_events` and `order_timelines` (one document per order with its events nested in an array); `product_reviews` (one document per product with its reviews, authors and replies nested) | Placing, cancelling, shipping and refunding write the history inside a MongoDB transaction that is aborted; adding a review also updates the product's rating in SQL, so both stores change in one Preview |
| `DemoDynamoUrl` | DynamoDB (`idempotency`, mode `guard`) | The `idempotency` table: one item per order key, kept a day | Placing an order **reads** the key (`GetItem`); the write that remembers it (`PutItem`) happens on Send only |

With MongoDB configured the API gains `OrdersController.Events` and the three `ReviewsController` operations. On first start the demo fills the stores from the seeded data (order counters, coupon counters and sample state in Redis; an event history per order and the reviews of every reviewed product in MongoDB; the recent order keys in DynamoDB); each fills only when empty. A store that is down at start is skipped with a warning.

### Run the local demo

Start the compose services, build the release binary and start it detached from the repository root. The demo listens on <http://127.0.0.1:5189> and the workbench is at <http://127.0.0.1:5189/sendproof/>:

```sh
docker compose -f tests/conformance/compose.yml up -d --wait redis mongodb dynamodb
dotnet build examples/StoreApi/StoreApi.csproj -c Release
cd examples/StoreApi && ASPNETCORE_ENVIRONMENT=Development \
  DemoRedisUrl='redis://:bench_redis_local@127.0.0.1:56379' \
  DemoMongoUrl='mongodb://127.0.0.1:57017/store?directConnection=true' \
  DemoDynamoUrl='http://127.0.0.1:58000' \
  nohup dotnet bin/Release/net10.0/StoreApi.dll --urls http://127.0.0.1:5189 > /tmp/store-demo.log 2>&1 < /dev/null &
```

Check it with `curl http://127.0.0.1:5189/sendproof/_api/capabilities` (200, with `dataStores` listing `redis`, `mongodb` and `dynamodb`). Stop it with `pkill -f 'StoreApi.dll'`. Leave out the `Demo…Url` variables to run it without the stores. The command must run from `examples/StoreApi`, because the database and keys sit beside the project.

## Journeys

Four journeys, defined in C# in [`Journeys/`](Journeys) and published at `/sendproof/journeys/store.arazzo.json` (Arazzo 1.1) and `store.expect.json` (what each step should write), as [Sendproof.Journeys](../../adapters/dotnet/Sendproof.Journeys/README.md) builds them at startup:

| Journey | Steps | What it shows |
| --- | --- | --- |
| Order to shipment | place an order by bank transfer, find its payment, capture it, ship it, read it back | SQLite and MongoDB writes at steps 1, 3 and 4; the approved difference AD-0011 at step 4, which fails when the carrier input isn't `Dhl` |
| Cancel before shipping | place an order by card, cancel it, find the refunded payment, read it back | stock, reservation, payment and refund writes |
| Ship an unpaid order | place an order by bank transfer, try to ship it | an expected refusal (422) that writes nothing |
| Price with a coupon | check a coupon, quote a basket, redeem the coupon | Send only: quoting writes Redis `SET quote:{id}` and redeeming `INCRBY` |

The operations they call are `StoreOperations`, generated from the endpoint mappings. MongoDB and Redis expectations are checked only when those stores are configured; without them they are reported Not checked.

## Seed data

A new database is filled once with deterministic data (a fixed random seed; dates are relative to the day it is created, so the data is always current): 5 staff and 6 customers with sign-ins, about 26 more customers (32 in all) across Ireland, Germany, the Netherlands, France, the UK, the US, Canada, Australia, Sweden, Switzerland and Japan with saved addresses; 21 categories; 44 products from six fictional brands with about 160 variants, each priced in ten currencies; stock with some variants out of stock and some low; 10 coupons (active, expired, exhausted, switched off); and about 140 orders in every status with payments (card, bank transfer, gift card), refunds, shipments with tracking scans and stock movements, plus open carts that hold stock. `NPK-JKT-BLK-M` always starts with exactly 40 units on hand and none reserved, and `Mia Customer` has no cart. Existing databases are never seeded or recreated.

## Reset

On first run the example creates `store-demo.db` in this directory. Stop the application and delete that file (and its SQLite sidecars, if present) to reset it. Set `DemoDatabasePath` to a separate, initially nonexistent file to run an isolated instance.

Session cookies are protected with keys kept in `store-demo.keys/`, beside the database, so sign-in never depends on the machine-wide `~/.aspnet/DataProtection-Keys` ring. Deleting the database and that folder resets the demo. Set `DemoKeyDirectory` to use a different private, writable directory outside the web root; the browser suite puts one beside its temporary database and removes both when it finishes.

This is a local development sample, not a production identity or payments system. It has no external payment, notification, or email integration. Preview covers the EF Core database and, when configured, MongoDB; Redis and DynamoDB are guarded. Idempotency illustrates sequential retries; the example does not implement production-grade concurrent order processing.

## Code layout

`Domain/` enums, persistence records, pricing rules and the notification queue · `Data/` the EF Core context · `Contracts/` the documented API models · `Endpoints/` one file per tag · `Journeys/` the journeys and their expected writes · `Stores/` the optional Redis, MongoDB and DynamoDB hooks · `OpenApi/` the document, operation and schema transformers and examples · `Seed/` the demo data.

Documentation comes from XML comments (`GenerateDocumentationFile`). Two details matter for that: handler methods must be `internal` or `public`, and `AddOpenApi` must be called with a lambda, or the OpenAPI source generator skips them.

## Tests

Run the in-process SQLite and TestServer integration tests with `dotnet test examples/StoreApi/tests/StoreApi.Tests.csproj`. They cover the Preview and Send flow, the order, shipment, refund and cancel flow, the seed data's integrity, that every operation, parameter and schema property in the OpenAPI document has a description, and every journey (`JourneyTests`, each on a throwaway database). If the test runner cannot bind a loopback socket, build that project and run `dotnet examples/StoreApi/tests/bin/Debug/net10.0/StoreApi.Tests.dll` to execute the same assertions without VSTest.
