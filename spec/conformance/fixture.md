# Sendproof conformance fixture

Implement a disposable HTTP app backed by one real relational table, `items`, with a string primary key `id` and a string `name`. Every new process starts with an empty table. The runner starts each fixture on loopback and sets these variables.

| Variable | Meaning |
| --- | --- |
| `PORT` | Port to listen on |
| `BENCH_PATH_BASE` | Application mount, empty or `/tenant` |
| `BENCH_SCENARIO` | `standard`, `disabled`, `no-provider`, or `rollback-failure` |
| `BENCH_TMP_DIR` | Disposable directory for fixture keys, storage and logs |
| `BENCH_DATABASE` | Database selected by the manifest entry. Values are `sqlite`, `h2`, `postgresql`, `mysql` and `sqlserver`. |
| `BENCH_DATABASE_URL` | Connection URL for a fresh database on a local service. Set for PostgreSQL, MySQL (and MariaDB) and SQL Server. |
| `BENCH_DATABASE_SERVER` | The manifest `database`, which differs from `BENCH_DATABASE` only for MariaDB: a `mariadb` entry runs with `BENCH_DATABASE=mysql` (the MySQL wire protocol, the same fixture and driver) and `BENCH_DATABASE_SERVER=mariadb`. A fixture that has to tell the servers apart (Laravel's `mariadb` driver, the MariaDB JDBC driver) reads it. |

`GET /ready` returns HTTP 200 after startup in all scenarios. Paths in this document are relative to the mount. Mount the real workbench at `/sendproof`. Publish the fixture's OpenAPI document at the framework's normal path, with `info.title` set to `Sendproof Conformance` and paths for the operations below. Its schemas must describe the request and response shapes used by this fixture. The runner discovers the actual document URL from capabilities.

Server-database fixtures create the `items` table in the supplied empty database. The runner owns the database lifetime and drops it after stopping the fixture. It checks the standard scenario through a second database connection to confirm that the HTTP fixture used the selected engine and persisted only committed writes.

## Authentication

- Advertise a `cookie` provider at `/auth/sign-in`. Accept `POST {"email":"admin@example.test","password":"bench-fixture"}` and set a same-origin session cookie. Incorrect credentials return 401. The admin identity displays `Fixture Admin` and has role `admin`.
- Advertise `personas` at `/auth/personas`. An authenticated admin can GET the list, which includes `{ "email": "viewer@example.test", "name": "Fixture Viewer", "role": "viewer" }`. `POST /auth/personas/viewer%40example.test` sets a new session for that viewer. Anonymous clients may do neither, and a rejected sign-in or persona switch must leave the caller anonymous even if the response sets a cookie.
- The admin can execute every operation. The viewer can read items. Writes from a viewer return 403, while anonymous API callers receive 401. The UI and discovery are public in the standard scenario. Trace retrieval requires the owner of the trace, identified by a stable authenticated subject.

## API operations

| Method and path | Handler behavior |
| --- | --- |
| `GET /items/{id}` | Return `{id,name}` or 404. The runner uses a separate normal request to check durable state. |
| `POST /items` | Accept `{id,name}`, insert an item, and return 201 and `{id,name}`. Record an `email` effect with description `Created item`, log `created:<id>`, and execute a bound SQL parameter named `fixture_secret` with the non-data value `fixture-secret-value`. Invalid input receives a 4xx. |
| `PATCH /items/{id}` | Accept `{name}`, update the item, and return 200 and `{id,name}`. Copy the query parameter `tag` to `X-Fixture-Tag` in the response when present. |
| `DELETE /items/{id}` | Delete a row and return 204. |
| `POST /items/{id}/fail` | Insert the ID and fail with a handled application HTTP 409 or with an exception yielding an unconfirmed outer 500. |
| `POST /items/{id}/large` | Insert the ID and return a body over the preview response cap. |
| `POST /items/{id}/redirect` | Return a 302 with `Location: <path-base>/items/<id>` and an inner `Set-Cookie`. |
| `POST /items/{id}/capture` | Insert at least 201 distinct items (use ID prefix), register at least 101 effects and issue at least 501 logs in one request. |
| `POST /items/{id}/ordinary` | Insert an item using ordinary Send only. This route stays unmarked for Preview. |

Enable Preview for `POST /items`, `PATCH /items/{id}`, `DELETE /items/{id}`, and the `fail`, `large`, `redirect`, and `capture` operations. Route and authorize the rewritten request through the real framework. Changes identify the actual row key and include `insert`, `update`, or `delete` with before and after snapshots. Suppress the registered effect in Preview and mark it `delivered: true` when normal Send delivers it. Scope capture to one request and use the adapter's redaction rules for the secret-named SQL parameter. Use the default collection caps (500 logs, 100 effects, 200 changes), and configure trace retention at five seconds for tests when the adapter exposes a clock or TTL override. Other fixtures declare their retention or a local clock advance in the manifest.

## Alternate scenarios

- `disabled` deliberately runs outside the workbench's configured environments. Workbench routes and Preview are unavailable while ordinary application routes still work.
- `no-provider` registers no preview provider. The fixture still supports ordinary database writes and advertises zero preview operations.
- `rollback-failure` uses the usual provider for capture but reports an injected failure from rollback after promoting no data. The transport must withhold confirmation. An independent read must still find the database unchanged.

The fixtures exercise the actual protocol via HTTP. Auxiliary test configuration, authentication and database seed logic stay in the fixture.

## Shared security rules

These two rules come from the [security review](../../docs/security-review.md#follow-ups). A manifest entry opts in per rule with `"sharedRules": ["secret-columns", "raw-commit"]`; the runner reports a rule the entry doesn't list as not implemented rather than failing it.

| Method and path | Handler behavior |
| --- | --- |
| `POST /accounts` | Accept `{id,email,password}`, insert a row into a second table `accounts` with string columns `id` (primary key), `email` and `password_hash`, and return 201 and `{id,email}`. Store `password_hash` as the literal `hashed:<password>`: it is test data, so the runner can search captures for it. |
| `GET /accounts/{id}` | Return `{id,email}` or 404. |
| `POST /items/{id}/commit` | Accept `{name}`, insert the item, then execute a raw `COMMIT` on the same connection the handler uses, and return 201 and `{id,name}`. Ordinary Send behavior of this route is not checked. |

Enable Preview for `POST /accounts` and `POST /items/{id}/commit`.

- **`secret-columns`:** in the Preview envelope and in the observed-Send trace, the `accounts` change's `after.password_hash` is `"[REDACTED]"`, and neither the password nor `hashed:<password>` appears anywhere else, including SQL log parameters.
- **`raw-commit`:** the Preview answers 500 without confirmation, because the provider refuses transaction-control statements during a Preview ([data-stores.md](../data-stores.md#transaction-control-statements-from-the-handler)). A normal read afterwards finds no item.

### MySQL and MariaDB: `mysql-escape`

Entries on MySQL or MariaDB also list `"mysql-escape"` in `sharedRules`. At startup the fixture creates, if missing, a procedure that commits: `CREATE PROCEDURE sendproof_commit_probe() BEGIN COMMIT; END`. It declares no procedure as safe.

| Method and path | Handler behavior |
| --- | --- |
| `POST /items/{id}/escape` | Accept `{name, via}`, insert the item, then on the same connection run, by `via`: `"ddl"` runs `CREATE TABLE sendproof_escape_<id> (n INT)`, which commits implicitly; `"call"` runs `CALL sendproof_commit_probe()`. Return 201 and `{id,name}`. Enable Preview for it. |

- **`mysql-escape`:** for each `via`, the Preview answers 500 without confirmation, because the provider refuses the statement before sending ([data-stores.md](../data-stores.md#transaction-control-statements-from-the-handler)). A normal read afterwards finds no item, and for `"ddl"` no table `sendproof_escape_<id>` exists.

## Data store routes

A manifest entry that lists `"stores"` (any of `mongodb`, `redis` and `dynamodb`) adds the routes for those stores, hooks each store's client as its binding documents, and advertises the stores in capabilities `dataStores`. The runner provisions a fresh namespace per fixture process, passes it in these variables, and removes it after stopping the fixture. The services are the ones in [compose.yml](../../tests/conformance/compose.yml).

| Variable | Meaning |
| --- | --- |
| `BENCH_MONGODB_URL` | `mongodb://` URL whose path names a fresh database, with `directConnection=true`. Use collection `documents`. |
| `BENCH_REDIS_URL` | `redis://` URL with the server password. The password must never appear in a capture. |
| `BENCH_REDIS_PREFIX` | Fresh key prefix, such as `tb_1a2b3c:`. Prefix every key with it. |
| `BENCH_DYNAMODB_URL` | DynamoDB endpoint URL. |
| `BENCH_DYNAMODB_TABLE` | A fresh table with string partition key `id`, created by the runner. |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` | Local-only credentials for DynamoDB Local. The secret key must never appear in a capture. |

### MongoDB routes (`preview` mode)

Documents have the shape `{_id, name, profile: {city}, password_hash}`.

| Method and path | Handler behavior |
| --- | --- |
| `GET /documents/{id}` | Return `{id,name,city}` or 404. |
| `POST /documents` | Accept `{id,name,city,password}`, insert `{_id: id, name, profile: {city}, password_hash: "hashed:<password>"}`, log `created-document:<id>`, and return 201 and `{id,name,city}`. |
| `PATCH /documents/{id}` | Accept `{name?,city?}`, apply them with one `updateOne` using `$set` (`profile.city` for the city), and return 200 and the updated `{id,name,city}`, or 404. |
| `POST /documents/archive` | Run `aggregate` on `documents` with the pipeline `[{ "$match": {} }, { "$out": "documents_archive" }]` and return 204. |
| `DELETE /documents/{id}` | Delete the document and return 204. Marked `preview: false`. |

### Redis routes (`guard` mode)

Counters live at `<prefix>counter:<key>`.

| Method and path | Handler behavior |
| --- | --- |
| `GET /counters/{key}` | `GET` the counter and return 200 and `{key,value}` with an integer value, or 404. |
| `POST /counters/{key}` | `INCR` the counter and return 200 and `{key,value}`. |
| `POST /counters/{key}/take` | `GETDEL` the counter and return 200 and `{key,value}`, or 404. |
| `DELETE /counters/{key}` | `DEL` the counter and return 204. Marked `preview: false`. |

### DynamoDB routes (`guard` mode)

Items in `BENCH_DYNAMODB_TABLE` have the shape `{id, status, hits}`.

| Method and path | Handler behavior |
| --- | --- |
| `GET /orders/{id}` | `GetItem` and return 200 and `{id,status,hits}`, or 404. |
| `POST /orders/{id}/touch` | `UpdateItem` with `ADD hits :one SET #s = if_not_exists(#s, :new)` (`#s` is `status`, `:new` is `"new"`) and `ReturnValues: ALL_NEW`, and return 200 and `{id,status,hits}`. |
| `POST /orders/{id}/cancel` | `ExecuteStatement` with `UPDATE "<table>" SET status = 'cancelled' WHERE id = ?`, and return 200 and `{id,status}`. |
| `DELETE /orders/{id}` | `DeleteItem` and return 204. Marked `preview: false`. |

### Mixed SQL and store route

| Method and path | Handler behavior |
| --- | --- |
| `POST /items/{id}/remember?store=<store>` | Accept `{name}`, insert the item into `items`, then write the named guarded store: `INCR <prefix>counter:item-<id>` for `redis`, or the `touch` update on item `item-<id>` for `dynamodb`. Return 201 and `{id,name}`. |

Enable Preview for every route in these tables except the ones marked `preview: false`. Report each marked route in capabilities `previewUnavailable` with the reason `Preview unavailable: this operation writes to <Store>` and `stores: ["<store>"]`. Log every store command as a `Db` entry in Previews and observed-Send traces.
