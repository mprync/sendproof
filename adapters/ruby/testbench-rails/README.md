# testbench-rails

Rails engine for [Test Bench](../README.md). Tested with Rails 8.0.5.2 (API mode, cookie sessions, Puma).

```ruby
# config/initializers/test_bench.rb
Rails.application.configure do
  config.test_bench.environments = %w[development]
  config.test_bench.api_name = "Inventory"                    # default: the application class
  config.test_bench.open_api_url = "/openapi.json"
  config.test_bench.auth_provider "Staff", "cookie", "/auth/sign-in"
  config.test_bench.identity = ->(request) { ... }            # { name:, role:, subject: } or nil
  config.test_bench.use TestBench::ActiveRecord::Provider.new
end
```

## Marking actions

```ruby
class ItemsController < ApplicationController
  test_bench_preview only: %i[create update]    # or except: [...], or bare for every action
end
```

Discovery lists the verbs and `{param}` path templates of marked, routed actions, so `previewOperations` always matches the router. Mounted Rack apps are never listed. An unmarked or unknown target is refused (409/404) before any transaction opens.

## How it integrates

- The engine appends `TestBench::Middleware` as the **last** middleware, after cookies, session and authentication middleware and right before the router, so a preview is routed and authenticated like a real call.
- A hook around `send_action` anchors the preview at the real action, after `before_action` authentication and authorization. A request halted by a filter never reaches it, so it is never confirmed.
- Framework-handled exceptions that Rails maps to a client error (`RecordNotFound`, `ParameterMissing`, …) become confirmed inner responses; anything that maps to 500 is unconfirmed.
- `Rails.logger` entries at `config.test_bench.log_level` (default `:info`) and above are copied into the capture through a broadcast sink. SQL appears as structured `Sql` entries instead.
- The preview's session and cookies are never written to the real response.

Observed Send (`Prefer: trace`) needs `identity` to return a `subject`; the trace is readable only by that subject on that mount and expires after `trace_ttl` seconds (default 300).

Not included: ActionMailer, ActiveJob and HTTP-client interceptors, OIDC challenge routes.
