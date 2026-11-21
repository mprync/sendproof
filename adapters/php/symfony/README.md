# Sendproof for Symfony

Sendproof adds an API workbench to a Symfony application: browse your OpenAPI document, edit requests, **Send** them, **Preview** a write with a real Doctrine rollback, and read the SQL, logs, effects and row changes that an **Observed Send** produced.

The bundle implements [Sendproof protocol v1](../../../spec/README.md). Preview hands the rewritten request to the real HTTP kernel in the same process, as a main request, inside a transaction that is always rolled back. The firewall, access control, listeners, argument resolvers and your controller all run exactly as for a normal request.

> **Status:** `0.1.0-alpha.1`. Tested with Symfony 8.1, Doctrine DBAL 4.6, ORM 3.8 and DoctrineBundle 3.4 on PHP 8.4 and SQLite. The package allows Symfony 7–8 and PHP 8.2+, but only the tested combination is verified.

## Install

```sh
composer require sendproof/symfony
```

Register the bundle (Flex does this for you) and import the workbench routes:

```php
// config/bundles.php
Sendproof\Symfony\SendproofBundle::class => ['all' => true],
```

```yaml
# config/routes/sendproof.yaml
sendproof:
    resource: '@SendproofBundle/config/routes.php'
```

## Turn it on

The workbench is **off by default** and refuses to run in production. It answers only when both conditions hold:

```yaml
# config/packages/sendproof.yaml
sendproof:
    enabled: true
    environments: ['dev']      # kernel environments, default ['dev']
    openapi_url: /api/doc.json
```

With the switch off, or in an unlisted environment, `/sendproof/...` and `/sendproof/_preview/...` return 404. Do not list `prod` unless you have also restricted access with `sendproof.authorize` and understand that previews run real application code.

## Opt operations in

Preview and Observed Send are explicit per action. Add `#[AllowPreview]` to the controller method (or class), or set the route default `_sendproof_preview: true`:

```php
use Sendproof\Symfony\Attribute\AllowPreview;

#[Route('/items', methods: ['POST'])]
#[AllowPreview]
public function create(Request $request): Response { /* ... */ }
```

Unmarked routes still work normally with Send. A preview of an unmarked route returns 409 and never runs the controller. Authentication and authorization stay in your firewall and `access_control`; the request counts as admitted only after they pass.

## What Preview guarantees

- `POST /sendproof/_preview/items` is rewritten to `POST /items` and handled in-process. Method, query, headers and body are preserved. Nothing leaves the application.
- A transaction opens on every connection in `sendproof.connections` before the request is handled, and is rolled back afterwards. The result is confirmed only if rollback is verified. If the controller commits or closes the preview transaction, or rollback fails, you get an error response and no envelope.
- Responses of 401 or 403, redirects before the controller, unhandled exceptions, responses over 1 MiB, unavailable providers and missing preferences never produce a confirmed envelope.
- Cookies and `Location` from the inner response are dropped.
- Outgoing Symfony Mailer messages are captured and **not sent**. Deliver anything else through the recorder (below).

### Record external effects

Inject `Sendproof\Core\Capture\Recorder` and ask before delivering anything outside the database. It returns `true` during a preview, so skip the effect then:

```php
if (!$this->recorder->tryRecordHttp('Notify billing', 'POST', $url, body: $payload)) {
    $this->http->request('POST', $url, ['json' => $payload]);
}
```

`tryRecordEmail`, `tryRecordHttp`, `tryRecordJob`, `tryRecordMessage` and `tryRecordEffect` follow the conventional shapes in the protocol. In an Observed Send they record the effect as `delivered: true` and return `false`.

## What is captured

| Source | How |
| --- | --- |
| Row changes | ORM `onFlush`/`postFlush` with before and after snapshots keyed by column name. Secret-named columns are `[REDACTED]`. |
| SQL | A DBAL driver middleware: text, bound values, duration and **rows affected** for writes. Values are shown only in `dev` and `test`; anything near a secret-named binding or statement is `[REDACTED]`. |
| Logs | Monolog records through a global processor. |
| Mail | Symfony Mailer `MessageEvent`: captured, rejected in a preview. |

Limits match the .NET adapter: 500 logs, 100 effects, 200 changes, 32 log properties and 64 SQL parameters. Truncation is reported with `logsTruncated`, `effectsTruncated` and `changesTruncated`.

## Known limits

- **Bulk and raw writes are not row changes.** DQL `UPDATE`/`DELETE`, `executeStatement()`, raw SQL, triggers and association join columns produce no ORM change. They still run inside the transaction, are rolled back, and appear in the SQL log.
- **Named parameters passed to `executeQuery($sql, ['name' => $v])` reach the driver as positional `?`.** DBAL rewrites them before any middleware sees them, so they are reported as `p0`, `p1`, … and redaction falls back to the statement text (which still catches secret column names). Use `$connection->prepare()` and `bindValue('name', …)` when the parameter name matters.
- **Only listed connections are rolled back.** Add every connection a previewed operation writes to in `sendproof.connections`. Other connections, caches, messenger transports, files and external services are not undone.
- **Implicit commits.** MySQL and MariaDB commit on DDL. A migration inside a preview ends the transaction and the preview is then withheld, but the schema change has happened.
- **Sessions** stored outside the listed connections are not rolled back.
- **Messenger, HTTP client and notifier calls** are not captured automatically. Record them with the recorder.
- **Logging needs a Monolog handler.** Monolog runs processors only for records that some handler will process.
- **Streamed and file responses** cannot be previewed.
- Observed-send ownership uses the user the firewall authenticated when the controller was entered, and is not re-checked afterwards.

## Configuration

| Key | Purpose |
| --- | --- |
| `enabled`, `environments` | Opt-in switch and allowed kernel environments. |
| `openapi_url`, `documents` | Where your OpenAPI document lives. |
| `auth_providers` | Sign-in methods shown by the workbench: `[{label: Staff, kind: oidc, url: /login}]`. |
| `authorize` | Security attribute (such as `ROLE_ADMIN`) required to open the workbench, and to preview or observe. |
| `identity` | Service implementing `Sendproof\Symfony\Identity\IdentityResolver` for the name and role shown. Defaults to the user identifier. |
| `provider` | `doctrine` (default), `null` to disable previews, or the id of your own `PreviewProvider` service. |
| `connections` | Doctrine connections enrolled in a preview. Default `['default']`. |
| `trace.ttl` | Seconds an observed-send trace stays readable. Default 300. |

## Observed Send

Send an operation with `Prefer: trace`. The response is untouched, plus an `X-Sendproof-Trace` header when an authenticated user with a stable identifier made the call. The trace is readable at `/sendproof/_api/traces/{id}` only by that user, for `sendproof.trace.ttl` seconds, with at most 8 traces per user and 32 in total. Traces are files in `var/sendproof-traces`, so they work across PHP-FPM workers.

## Tests

```sh
composer install && vendor/bin/phpunit
```

The Symfony conformance fixture is in [`../examples/symfony-fixture`](../examples/symfony-fixture/README.md).

## Data stores

Preview can also cover MongoDB, Redis (Predis) and DynamoDB. List the client services in `sendproof.data_stores`, and mark an operation you know writes to a guarded store with `#[AllowPreview(false, reason: 'Clears the Redis session')]`. Only the clients you list are covered. See [data stores in the PHP binding](../data-stores.md).
