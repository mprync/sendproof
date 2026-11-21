# Sendproof protocol v1

The client reads one OpenAPI document and one capabilities response. A framework adapter serves the embedded UI under the application's `/sendproof/` path. All application URLs below include the mount prefix when the host uses a path base such as `/tenant`.

## Discovery

`GET /sendproof/_api/capabilities` returns the [capabilities object](capabilities.schema.json) with `Cache-Control: no-store`. Resolve the identity on the current request. Treat the environment and database fields as display labels. Connection strings, credentials and database host secrets do not belong in this object.

```json
{
  "protocolVersion": 1,
  "apiName": "Inventory",
  "openApiUrl": "/openapi/v1.json",
  "documents": [{ "name": "Inventory", "url": "/openapi/v1.json" }],
  "environment": "Development",
  "database": { "name": "inventory_dev", "system": "postgresql" },
  "binding": { "language": "node", "framework": "Express" },
  "identity": { "name": "Alex" },
  "authProviders": [{ "label": "Staff SSO", "kind": "oidc", "url": "/account/sign-in" }],
  "previewOperations": [{ "method": "POST", "path": "/items" }],
  "observedSend": true
}
```

Two optional fields tell the workbench about the host so it can show the right things:

- `database` is a display name (a string, or null for none). A binding may send `{ "name": "inventory_dev", "system": "postgresql" }` instead. `system` is the SQL provider id, matching the workbench's store marks: `sqlite`, `postgresql`, `mysql`, `mariadb`, `mssql` (also written `sqlserver`), or another id the workbench has no mark for. The workbench then shows that provider's mark and name. Without `system` it guesses SQLite from a `.db`, `.sqlite` or `.sqlite3` file name and shows a generic SQL database otherwise.
- `binding` is `{ "language", "framework" }`: `language` is one of `dotnet`, `node`, `python`, `java`, `kotlin`, `go`, `php`, `ruby` or `rust`, and `framework` is the web framework's name as the binding spells it (free text, such as "ASP.NET Core", "Express", "FastAPI", "Spring Boot", "Laravel"). The workbench writes its "mark this route `preview: false`" guidance in that language. Without `binding` it offers a small language switch instead.

Clients reject unsupported major versions, ignore extra fields and refresh discovery after sign-in. A missing preview provider produces an empty operation list. Each entry uses the OpenAPI path template and HTTP verb. Advertising an operation gives the UI permission to offer the action. The server still authenticates, authorizes and checks preview capability on every request.

## Sign-in

An interactive provider advertises a label, kind and same-origin entry URL. A host page or remote challenge handles navigation and returns to the workbench. The workbench's built-in password form selects a provider with kind `cookie` and an entry URL. A configured password JSON integration accepts `POST { "email": "…", "password": "…" }` and establishes the host session. Custom payloads can use a host-managed sign-in page. A configured `personas` source returns an array of `{email,name,role}` and accepts a POST at its URL plus the encoded email to switch to an existing authorized development persona. Hosts decide who can use this mechanism.

Non-interactive handlers may have no entry URL. Each host is responsible for its configured challenges, cookie settings, redirect URIs and access policies. Authentication schemes in OpenAPI describe how a request is authenticated. They cannot establish which identity the host authenticated on this request.

## Request modes

| Mode | Destination | Completion |
| --- | --- | --- |
| Send | Original operation URL with its real method, query, headers and body | Ordinary endpoint response and normal commit behavior |
| Observed Send | Original operation URL with its real method, query, headers and body, plus `Prefer: trace` | Ordinary endpoint response and commit, with an optional trace ID |
| Preview | Original path prefixed with `/sendproof/_preview`, preserving method, query and body, plus `Prefer: tx=rollback` | Confirmed [preview envelope](preview.schema.json) after cleanup |

For example, `PATCH /tenant/items/12?audit=true` becomes `PATCH /tenant/sendproof/_preview/items/12?audit=true`. Preview must stay inside the host application: dispatch it in-process through the normal router, never as an outbound HTTP request built from the `Host` header or an absolute URL. The target after the prefix must not be empty, start with `//`, or decode to a backslash, a control character, a `.` or `..` segment, a `/sendproof` path or a second preview. Reject a preview with HTTP 400 or 403 when `Sec-Fetch-Site` is `cross-site` or when an `Origin` header is present and is not exactly the request's own scheme, host and port; the opaque origin `null` never matches. Clients disable redirects and automatic retries. Missing preference, disabled environments, unknown endpoints, unauthorized calls, unavailable providers, an oversized response or unsuccessful rollback do not yield a successful envelope.

```json
{
  "status": 201,
  "headers": { "content-type": "application/json" },
  "body": { "id": 12, "name": "Bolt" },
  "changes": [
    { "operation": "insert", "table": "Items", "key": { "Id": 12 },
      "before": null, "after": { "Id": 12, "Name": "Bolt" } }
  ],
  "effects": [{ "kind": "email", "description": "Stock notice", "data": null }],
  "logs": [{ "level": "Information", "message": "Created item" }],
  "rolledBack": true
}
```

The outer response uses HTTP 200, JSON, `Preference-Applied: tx=rollback` and `Cache-Control: no-store`. The inner status and body can describe an application failure such as a 400 validation problem. Never set cookies, follow redirects, or forward hop-by-hop headers from the captured inner response. The envelope's `headers` omit `Set-Cookie`, `Location`, `Content-Length` and the hop-by-hop headers (`Connection`, `Keep-Alive`, `Proxy-Authenticate`, `Proxy-Connection`, `TE`, `Trailer`, `Transfer-Encoding`, `Upgrade`). Captured logs, envelopes and traces never contain the caller's cookies or `Authorization` header. A client displays a rollback result only after a successful transport response with the correct envelope. An unconfirmed result stays unconfirmed.

## Capture

Preview envelopes and observed send traces can include structured logs. `level` and `message` remain required. Optional fields include `category`, `eventId: {id, name?}`, `offsetMs` from request start, `elapsedMs`, string-valued `properties` without `{OriginalFormat}`, and `exception: {type, message}`. SQL entries use `level: "Sql"` and `sql: {text, parameters: [{name, value, dbType}], rowsAffected?}`. Parameter values are strings or null. Redacted values use `"[REDACTED]"`. Row counts depend on the command and provider.

Effects require `kind` and `description`. Hosts may use any JSON `data`. These conventional shapes allow rich display.

| Kind | Conventional `data` keys |
| --- | --- |
| `email` | `from`, `to[]`, `cc[]`, `subject`, `text`, optional `html` |
| `http` | `method`, `url`, optional `status` and `body` |
| `job` | `name`, `arguments`, optional `queue` and ISO 8601 `runAt` |
| `message` | `topic`, `payload`, optional `key` |

Optional effect-data keys may be null. An observed send records effects that the host proceeds to deliver with `delivered: true`. Preview effects are suppressed by the host and omit that field. Treat effect bodies as data, including HTML email content.

An adapter reports capture limits using optional `logsTruncated`, `effectsTruncated` and `changesTruncated` booleans. The .NET adapters cap logs at 500 entries, effects at 100, changes at 200, log properties at 32 and SQL parameters at 64. Additional size limits apply to collections and strings. Omitted or truncated capture has no effect on normal Send or confirmed rollback.

## Observed Send

When capabilities contain `observedSend: true`, clients can send `Prefer: trace` to operations in `previewOperations` using the original URL. The response retains the application's status, headers and body. If present, `X-Sendproof-Trace` identifies a [trace](trace.schema.json) at `GET /sendproof/_api/traces/{id}`, with the same path base and credentials as the operation. The trace contains `changes`, `effects`, `logs` and `timing`. The .NET adapter requires an authenticated principal with an issued stable subject (`NameIdentifier` or `sub`), and applies any configured workbench authorization policy. The trace belongs to that subject and its authentication context. Missing, expired, evicted and foreign trace IDs return 404 to callers admitted to the workbench, as does a trace read from a cross-site or cross-origin request. Trace IDs carry at least 122 random bits from a cryptographic generator. An observed send from a cross-site or cross-origin request still runs normally but records no trace. Trace responses are non-cacheable. The .NET adapter retains up to eight traces per owner and 32 per host for up to five minutes.

The reference workbench traces Send by default when the capabilities report `environment: "Development"`, and leaves it off elsewhere; the user can turn it on or off in the result pane or the command palette, and the choice is kept in that browser. A trace is only requested for operations in `previewOperations`; other Sends are not traced, and the result pane says so.

## Timing

Successful .NET previews and observed sends emit `Server-Timing` with the metrics `auth`, `handler`, `db` and `serialize`, all in milliseconds. `db` is the sum of recorded command durations and its `desc` uses `"N queries"`. `auth` includes routing and access checks up to handler entry. `serialize` measures Sendproof capture serialization, including the preview envelope. Observed send headers reflect the work completed when response headers are written. The trace's final `timing` object includes `auth`, `handler`, `db`, `serialize` and integer `queryCount`.

## Field extensions

- `x-lookup: { "url": "/accounts", "valueField": "id", "labelField": "name", "detailField": "iban" }` supplies an authenticated collection lookup. A static list can use `options: [{ "value": "EUR", "label": "Euro" }]`. The selected value travels in the request.
- `x-currency-field: "currency"` on a numeric schema binds the currency selector to a sibling field. Both values retain their original JSON names and types.
- Sibling properties with the same `x-sendproof-row` string can share a form row. Use `x-sendproof-visible: true` to keep an optional property above the disclosure. A string `x-sendproof-type-label` supplies concise display text for a domain type. The underlying schema still controls validation and serialization.
- Standard schema fields and operation-level examples are portable across framework adapters. Custom UI controls must provide a usable native or JSON fallback when an extension is unknown.

## Data stores

Protocol v1.1 adds data stores other than the SQL database, as an additive revision: [data-stores.md](data-stores.md) is the full rule set. In brief:

- A store that can roll back (MongoDB on a replica set) runs in `preview` mode and joins the Preview transaction. A store that can't (Redis, DynamoDB, a standalone MongoDB) runs in `guard` mode: reads run, and the first write stops the Preview before it reaches the store.
- A blocked Preview answers HTTP 409 with an RFC 9457 problem whose `code` is `preview_unavailable` and whose `detail` reads, for example, "Preview unavailable: this operation writes to Redis". Any SQL work in the same Preview rolls back. Nothing is written.
- Capabilities may list `dataStores` (each store's mode) and `previewUnavailable` (operations an author marked `preview: false`, with a reason).
- Logs gain level `"Db"` with `db: {system, operation, target?, namespace?, statement?, parameters?, rowsAffected?}`, aligned with the OpenTelemetry database conventions and redacted like SQL parameters. Changes gain optional `store` and `namespace` for documents, items and keys.
- Shared tables in [data-stores/](data-stores/) classify every command; anything not listed is a write. Stores whose client the binding hasn't hooked are not covered.

## Implementing another adapter

An ASP.NET Core host can call `.WithFieldModule("/assets/inventory-fields.js")`. Serve that ES module as a normal same-origin static asset. The adapter adds the application path base to the URL in the optional `fieldModules` array. The UI loads each module once, in configuration order. Only host configuration supplies executable URLs.

```js
// /assets/inventory-fields.js
export const fieldRenderers = [{
  predicate: schema => schema.format === 'product-code',
  render({ id, value, setValue, required }) {
    const input = document.createElement('input');
    input.id = id;
    input.required = required;
    input.value = value ?? '';
    input.addEventListener('input', () => setValue(input.value));
    const control = document.createElement('div');
    control.className = 'control';
    control.append(input);
    return control;
  }
}];
```

The surrounding form supplies the label, validation and serialization. A renderer receives the resolved schema, current value, field path, ID, required flag and setter. Later registrations take precedence when predicates overlap.

For another .NET data layer, expose a fluent extension on `SendproofBuilder` that registers one scoped `IPreviewProvider`. Begin on the connection the handler will use. Return a session that supplies change snapshots, rolls back explicitly, and disposes partially acquired resources on every failure path. The EF package is a working example.

For another language or web framework, implement discovery and the reserved preview route around the normal authorized request dispatcher. Establish whether your data layer can enroll the whole operation before calling the handler. Only advertise eligible operations. A raw SQL provider must define its change capture mechanism, including trigger and bulk statement coverage. Protocol additions that change the meaning of rollback or a required field need a new major version.

Acceptance checks include two distinct APIs sharing the same UI, unknown fields in discovery, an unmarked route, denied authorization, validation inside a preview, independent database reads before and after rollback, normal Send persistence, disposal after an exception, and clean failure when the provider cannot confirm rollback.

The [reference fixture contract](conformance/fixture.md) specifies how a binding can exercise these behaviors with the same HTTP runner.
