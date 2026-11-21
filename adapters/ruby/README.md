# Sendproof for Ruby

Mount the Sendproof workbench inside a Rails API and preview what a request will do before you send it. Preview runs the real controller action inside a database transaction, returns the response, the changed rows, suppressed side effects and logs, then rolls everything back. **Send** is the ordinary request.

| Gem | Purpose |
| --- | --- |
| [`sendproof-core`](sendproof/README.md) | Framework-neutral Rack middleware: embedded UI, discovery, preview transport, observed-send traces. |
| [`sendproof-activerecord`](sendproof-activerecord/README.md) | Preview provider: real SQL transactions, model change capture, SQL log with redaction. |
| [`sendproof-rails`](sendproof-rails/README.md) | Rails engine: `config.sendproof`, router-based discovery, the `sendproof_preview` controller macro. |

Tested with Ruby 3.4.3, Rails 8.0.5.2 (ActiveRecord, Action Pack), Rack 3.2.8, SQLite (`sqlite3` 2.10.2) and Puma 8.1.2. Other versions and databases are not claimed.

## Quick start (Rails)

```ruby
# Gemfile
group :development do
  gem "sendproof-rails"
  gem "sendproof-activerecord"
end
```

```ruby
# config/initializers/sendproof.rb
Rails.application.configure do
  config.sendproof.environments = %w[development]   # nothing is served anywhere else
  config.sendproof.open_api_url = "/openapi.json"    # your OpenAPI document, same origin
  config.sendproof.identity = lambda do |request|     # who is signed in (optional)
    user = User.find_by(id: request.session[:user_id])
    user && { name: user.name, role: user.role, subject: user.id.to_s }
  end
  config.sendproof.use Sendproof::ActiveRecord::Provider.new
end
```

```ruby
class ItemsController < ApplicationController
  sendproof_preview only: %i[create update destroy]   # opt in each reviewed action
end
```

Browse to `/sendproof/`. Nothing is enabled until `environments` names the running environment, and production is never implied.

## Repository tasks

All commands run from this directory and keep dependencies in `vendor/bundle`.

```sh
bin/prepare     # bundle install (network, once) + pack the shared UI bundle (needs Node)
bin/test        # core, ActiveRecord, Rails and fixture suites; no network
bin/fixture     # conformance fixture; honours PORT, BENCH_PATH_BASE, BENCH_SCENARIO
bundle exec rake build   # packs the UI and builds the three gems into pkg/
```

The UI is never copied by hand. `rake ui:pack` runs `node tools/pack-ui.mjs --version 0.1.0-alpha.1` and writes `sendproof/lib/sendproof/ui` (`manifest.json` plus the files), which is embedded in the `sendproof-core` gem. Each file's SHA-256 is verified against the manifest before it is served.

Shared HTTP conformance, from the repository root: `node tests/conformance/run.mjs ruby-rails`.

## Safety model

- **Opt-in.** Environments, providers and actions are all explicit.
- **Real dispatch.** A preview is rewritten to the original path and sent through the application's own middleware, router and controller callbacks, so authentication and authorization are the host's.
- **Transaction first.** The provider opens the transaction before dispatch, so `before_action` writes are covered too.
- **No confirmation without proof.** The envelope is returned only after the handler finished, rollback was confirmed and the response fit the 1 MiB limit. Missing preference, disabled environment, unknown or unmarked target, denied access, provider failure or failed rollback all produce a non-envelope answer.
- **Private traces.** Observed-send traces belong to a stable authenticated subject on one mount and expire (default 5 minutes).

## Known gaps

- No ActionMailer, ActiveJob or Net::HTTP integration yet. Record side effects explicitly with `Sendproof.deliver` / `Sendproof.record_effect`.
- `after_commit` callbacks run when each inner transaction completes during a preview (Rails treats the preview transaction like a transactional test). Route their side effects through `Sendproof.deliver`.
- Changes come from model callbacks. `update_all`, `delete_all`, `insert_all`, `touch`, raw SQL and triggers are rolled back but not listed, and the preview logs a warning.
- Work on other threads, streamed (`ActionController::Live`) responses and several independent databases are outside the guarantee unless every connection class is listed in the provider.
- `Rails.logger` must be an `ActiveSupport::BroadcastLogger` (the Rails default) to capture log lines.
- OIDC/OAuth sign-in challenges (`/sendproof/_api/challenge`) are not implemented; use `auth_provider` with a host sign-in route.
