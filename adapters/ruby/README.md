# Sendproof for Ruby

Mount the Sendproof workbench inside a Rails API and preview what a request will do before you send it. Preview runs the real controller action inside a database transaction, returns the response, the changed rows, suppressed side effects and logs, then rolls everything back. **Send** is the ordinary request.

| Gem | Purpose |
| --- | --- |
| [`sendproof-core`](sendproof/README.md) | Framework-neutral Rack middleware: embedded UI, discovery, preview transport, observed-send traces. |
| [`sendproof-activerecord`](sendproof-activerecord/README.md) | Preview provider: real SQL transactions, model change capture, SQL log with redaction. |
| [`sendproof-rails`](sendproof-rails/README.md) | Rails engine: `config.sendproof`, router-based discovery, the `sendproof_preview` controller macro. |

Tested with Ruby 3.4.3, Rails 8.0.5.2 (ActiveRecord, Action Pack), Rack 3.2.8, SQLite (`sqlite3` 2.10.2), MySQL 8.4 (Trilogy 2.13), Puma 8.1.2, and for the data stores Mongoid 9.1 on `mongo` 2.26, `redis` 5.4 on `redis-client` 0.31 and `aws-sdk-dynamodb` 1.187. Other versions and databases are not claimed.

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

## Data stores

MongoDB (Mongoid and the `mongo` driver), Redis (`redis-client`, `redis` 5) and DynamoDB (`aws-sdk-dynamodb`) are covered only through the clients you hook. [Data stores in the Ruby binding](data-stores.md) covers setup, the `sendproof_no_preview` mark and what each store does in a Preview.

```ruby
config.sendproof.data_store Sendproof::Mongoid::Store.new(name: "catalog")   # require "sendproof/mongoid"
config.sendproof.data_store Sendproof::Redis::Store.new(name: "cache")       # require "sendproof/redis"
config.sendproof.data_store Sendproof::DynamoDB::Store.new(client: dynamodb) # require "sendproof/dynamodb"
```

## Repository tasks

All commands run from this directory and keep dependencies in `vendor/bundle`.

```sh
bin/prepare     # bundle install (network, once) + pack the shared UI bundle (needs Node)
bin/test        # core, ActiveRecord, Rails and fixture suites; the store tests need the compose services and skip without them
bin/test-mysql  # the ActiveRecord suite on MySQL (BENCH_DATABASE=mysql, BENCH_DATABASE_URL=mysql://...)
bin/fixture     # conformance fixture; honours PORT, BENCH_PATH_BASE, BENCH_SCENARIO and the store variables
bundle exec rake build   # packs the UI and builds the three gems into pkg/
```

The UI is never copied by hand. `rake ui:pack` runs `node tools/pack-ui.mjs --version 0.1.0-alpha.1` and writes `sendproof/lib/sendproof/ui` (`manifest.json` plus the files), which is embedded in the `sendproof-core` gem. Each file's SHA-256 is verified against the manifest before it is served.

Shared HTTP conformance, from the repository root: `node tests/conformance/run.mjs ruby-rails` (with `mongodb redis dynamodb` from `tests/conformance/compose.yml` running) and `node tests/conformance/run.mjs ruby-rails-mysql` (with `BENCH_MYSQL_URL` and the `mysql` service).

## Safety model

- **Opt-in.** Environments, providers and actions are all explicit.
- **Real dispatch.** A preview is rewritten to the original path and sent through the application's own middleware, router and controller callbacks, so authentication and authorization are the host's.
- **Transaction first.** The provider opens the transaction before dispatch, so `before_action` writes are covered too. A handler `COMMIT` is refused before it reaches the database.
- **No confirmation without proof.** The envelope is returned only after the handler finished, rollback was confirmed and the response fit the 1 MiB limit. Missing preference, disabled environment, unknown or unmarked target, denied access, provider failure or failed rollback all produce a non-envelope answer.
- **Private traces.** Observed-send traces belong to a stable authenticated subject on one mount and expire (default 5 minutes).

## Known gaps

- No ActionMailer, ActiveJob or Net::HTTP integration yet. Record side effects explicitly with `Sendproof.deliver` / `Sendproof.record_effect`.
- `after_commit` callbacks run when each inner transaction completes during a preview (Rails treats the preview transaction like a transactional test). Route their side effects through `Sendproof.deliver`.
- Changes come from model callbacks. `update_all`, `delete_all`, `insert_all`, `touch`, raw SQL and triggers are rolled back but not listed, and the preview logs a warning.
- Work on other threads, streamed (`ActionController::Live`) responses and several independent databases are outside the guarantee unless every connection class is listed in the provider.
- `Rails.logger` must be an `ActiveSupport::BroadcastLogger` (the Rails default) to capture log lines.
- OIDC/OAuth sign-in challenges (`/sendproof/_api/challenge`) are not implemented; use `auth_provider` with a host sign-in route.
