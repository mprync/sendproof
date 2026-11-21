# sendproof-core

Framework-neutral Rack core of [Sendproof](https://github.com/mprync/sendproof) (bench protocol v1). It serves the embedded workbench UI under `/sendproof/`, answers discovery, runs rollback previews through your application, and stores observed-send traces.

Most Rails users want [`sendproof-rails`](../sendproof-rails/README.md). Use the core directly for Sinatra, Roda, Hanami or any Rack app.

```ruby
# config.ru
use Sendproof::Middleware,
    environments: %w[development], environment: ENV.fetch("RACK_ENV"),
    open_api_url: "/openapi.json",
    identity: ->(request) { (u = request.session[:user]) && { name: u["name"], subject: u["id"] } },
    preview_operations: [%w[POST /items], %w[PATCH /items/{id}]],
    providers: [Sendproof::ActiveRecord::Provider.new]
run App
```

Place the middleware after session and authentication middleware and before the router.

## What you wire up

1. **Handler hook.** Wrap the endpoint handler (after authentication and authorization) in `Sendproof::Handler.around(env, eligible: true) { ... }`. The preview transaction, observed-send capture and "did the handler run" decision are anchored there. Without it a Rack-only application cannot be previewed. `sendproof-rails` does this for every controller action.
2. **Operations.** `preview_operations` is a list of `[verb, "/path/{param}"]` (or a callable). The default resolver matches requests against it. Adapters can set `target_resolver` (`method, path, env -> :eligible | :ineligible | nil`).
3. **Provider.** Register exactly one object responding to `available?`, `database`, `begin_preview(context)` and optionally `begin_observation(context)`. See `Sendproof::Provider` for the session contract (`changes`, `rollback!`, `close`).
4. **Identity (optional).** `identity` returns `{name:, role:, subject:}`. The `subject` owns observed-send traces; without one no trace is recorded.

## Recording side effects

```ruby
# Returns true in a preview (skip it). In an observed send it records "delivered" and returns false.
unless Sendproof.record_email("Welcome", from: "noreply@example.test", to: [user.email], subject: "Hi", text: "…")
  Mailer.deliver(...)
end
Sendproof.deliver(:job, "Index item") { IndexJob.perform_later(id) }   # skipped in preview
Sendproof.log("Warning", "stock below threshold")
```

## Configuration

| Option | Default | Notes |
| --- | --- | --- |
| `environments` | none | Environments in which anything is served. |
| `open_api_url` | required | Same-origin path of the OpenAPI document. |
| `open_api_document(name, url)` | | Extra documents for the picker. |
| `auth_provider(label, kind, url)` | | `cookie` (password JSON), `personas`, or a host sign-in page. |
| `field_module(url)` | | Host-served ES module with custom field renderers. |
| `authorize` | allow | `request -> truthy` gate for workbench routes and previews. |
| `include_sql_parameter_values` | development only | Secret-looking names are always `[REDACTED]`. |
| `trace_ttl` / `trace_clock` | 300 s / monotonic | A test can inject a clock or a short TTL. |
| `exception_status` | none | `error -> 4xx` turns a framework-handled exception into a confirmed inner response. |
| `ui_directory` | embedded bundle | Directory with `manifest.json` from `tools/pack-ui.mjs`. |

Limits match the .NET adapter: 500 logs, 100 effects, 200 changes, 32 log properties, 64 SQL parameters, 1 MiB preview response, 8 traces per owner and 32 in total.
