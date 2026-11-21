# Test Bench conformance fixture

Implement a disposable HTTP app backed by one real relational table, `items`, with a string primary key `id` and a string `name`. Every new process starts with an empty table. The runner starts each fixture on loopback and sets these variables.

| Variable | Meaning |
| --- | --- |
| `PORT` | Port to listen on |
| `BENCH_PATH_BASE` | Application mount, empty or `/tenant` |
| `BENCH_SCENARIO` | `standard`, `disabled`, `no-provider`, or `rollback-failure` |
| `BENCH_TMP_DIR` | Disposable directory for fixture keys, storage and logs |
| `BENCH_DATABASE` | Database selected by the manifest entry. Values are `sqlite`, `h2`, `postgresql`, `mysql` and `sqlserver`. |
| `BENCH_DATABASE_URL` | Connection URL for a fresh database on a local service. Set for PostgreSQL, MySQL and SQL Server. |

`GET /ready` returns HTTP 200 after startup in all scenarios. Paths in this document are relative to the mount. Mount the real workbench at `/bench`. Publish the fixture's OpenAPI document at the framework's normal path, with `info.title` set to `Test Bench Conformance` and paths for the operations below. Its schemas must describe the request and response shapes used by this fixture. The runner discovers the actual document URL from capabilities.

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
