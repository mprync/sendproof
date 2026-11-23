# frozen_string_literal: true

# The Sendproof conformance fixture: a disposable Rails API backed by one real SQLite table.
# It doubles as the reference setup for sendproof-rails and sendproof-activerecord.
#
# Environment: PORT (set by the server), BENCH_PATH_BASE (see config.ru), BENCH_SCENARIO
# (standard, disabled, no-provider or rollback-failure), BENCH_DATABASE (sqlite, mysql or postgresql) with
# BENCH_DATABASE_URL, and the data-store variables of spec/conformance/fixture.md: BENCH_MONGODB_URL,
# BENCH_REDIS_URL with BENCH_REDIS_PREFIX, BENCH_DYNAMODB_URL with BENCH_DYNAMODB_TABLE, and
# BENCH_OPENSEARCH_URL with BENCH_OPENSEARCH_INDEX. Ruby has no maintained Cassandra client, so the
# fixture never serves the Cassandra routes.

require "tmpdir"
require "fileutils"
require "rails"
require "action_controller/railtie"
require "active_record/railtie"
require "sendproof/rails"
require "sendproof/active_record"
require "sendproof/mongoid" if ENV["BENCH_MONGODB_URL"]
require "sendproof/redis" if ENV["BENCH_REDIS_URL"]
require "sendproof/dynamodb" if ENV["BENCH_DYNAMODB_URL"]
require "sendproof/opensearch" if ENV["BENCH_OPENSEARCH_URL"]
require "redis" if ENV["BENCH_REDIS_URL"]

# SQLite by default: every process gets its own empty database file, removed on exit. BENCH_DATABASE=mysql
# uses the fresh server database the conformance runner created (BENCH_DATABASE_URL, mysql://...), through
# Trilogy.
if ENV["BENCH_DATABASE"] == "mysql"
  ENV["DATABASE_URL"] = ENV.fetch("BENCH_DATABASE_URL").sub(/\Amysql:/, "trilogy:") + "?pool=8"
elsif ENV["BENCH_DATABASE"] == "postgresql"
  # PostgreSQL through the pg gem (libpq), on the same kind of fresh server database.
  ENV["DATABASE_URL"] = ENV.fetch("BENCH_DATABASE_URL").sub(/\Apostgres(ql)?:/, "postgresql:") + "?pool=8"
else
  database_path = ENV["BENCH_SQLITE_PATH"]
  unless database_path
    directory = Dir.mktmpdir("sendproof-fixture-")
    at_exit { FileUtils.remove_entry(directory, true) }
    database_path = File.join(directory, "fixture.sqlite3")
  end
  ENV["DATABASE_URL"] = "sqlite3:#{database_path}?timeout=5000&pool=8"
end

module Fixture
  SCENARIO = ENV.fetch("BENCH_SCENARIO", "standard")
  MONGODB_URL = ENV["BENCH_MONGODB_URL"]
  REDIS_URL = ENV["BENCH_REDIS_URL"]
  DYNAMODB_URL = ENV["BENCH_DYNAMODB_URL"]
  OPENSEARCH_URL = ENV["BENCH_OPENSEARCH_URL"]
  STORES = (SCENARIO == "no-provider" ? [] : [(:mongodb if MONGODB_URL), (:redis if REDIS_URL), (:dynamodb if DYNAMODB_URL),
                                              (:opensearch if OPENSEARCH_URL)].compact).freeze
  # On MySQL the fixture also serves the mysql-escape route (spec/conformance/fixture.md).
  MYSQL = ENV["BENCH_DATABASE"] == "mysql"
  PASSWORD = "bench-fixture"
  USERS = {
    "admin@example.test" => { name: "Fixture Admin", role: "admin" },
    "viewer@example.test" => { name: "Fixture Viewer", role: "viewer" }
  }.freeze

  # Raised from a rollback to prove the transport withholds confirmation.
  class InjectedRollbackFailure < StandardError; end

  # Same provider, but its rollback reports a failure after the transaction was really rolled back.
  class FailingRollbackProvider < Sendproof::ActiveRecord::Provider
    def begin_preview(context)
      super.tap do |session|
        session.define_singleton_method(:rollback!) do
          super()
          raise InjectedRollbackFailure, "injected rollback failure"
        end
      end
    end
  end

  # The stores the application uses, as an application would configure them. Mongoid is configured before
  # the application class so the store hook can reach its client.
  if MONGODB_URL
    Mongoid.logger = Logger.new(IO::NULL)
    Mongoid.load_configuration(clients: { default: { uri: MONGODB_URL, options: { server_selection_timeout: 5 } } })
  end
  REDIS = (::Redis.new(url: REDIS_URL) if REDIS_URL)
  DYNAMODB = if DYNAMODB_URL
               Aws::DynamoDB::Client.new(endpoint: DYNAMODB_URL, region: ENV.fetch("AWS_REGION", "us-east-1"),
                                         access_key_id: ENV.fetch("AWS_ACCESS_KEY_ID", "benchlocal"),
                                         secret_access_key: ENV.fetch("AWS_SECRET_ACCESS_KEY", "benchlocal"))
             end
  # Built before the store, as an application's own initializers may: the global store hooks it in place.
  OPENSEARCH = (::OpenSearch::Client.new(url: OPENSEARCH_URL) if OPENSEARCH_URL)

  # What an application would have sent. Previews suppress delivery; ordinary sends append here.
  OUTBOX = []

  class Application < Rails::Application
    config.load_defaults 8.0
    config.api_only = true
    config.eager_load = false
    config.enable_reloading = false
    config.secret_key_base = "fixture-only-secret-key-base-not-used-elsewhere"
    config.consider_all_requests_local = false
    config.hosts.clear
    config.cache_store = :null_store
    # What a Rails application ships (config/initializers/filter_parameter_logging.rb): without it the request
    # log, which a capture copies, would show the password of an account the handler creates.
    config.filter_parameters += %i[passw secret token]
    config.logger = ActiveSupport::BroadcastLogger.new(ActiveSupport::Logger.new($stderr, level: :info))
    config.root = __dir__

    # Cookie sessions, as a real login would use. They run before Sendproof in the stack.
    config.middleware.use ActionDispatch::Cookies
    config.middleware.use ActionDispatch::Session::CookieStore, key: "_fixture_session", same_site: :lax

    bench = config.sendproof
    bench.environments = SCENARIO == "disabled" ? %w[staging] : [Rails.env]
    bench.api_name = "Sendproof Conformance"
    bench.open_api_url = "/openapi/v1.json"
    bench.journey "journeys/conformance.arazzo.json"
    bench.trace_ttl = 5
    bench.auth_provider "Fixture sign-in", "cookie", "/auth/sign-in"
    bench.auth_provider "Fixture accounts", "personas", "/auth/personas"
    bench.identity = lambda do |request|
      email = request.session[:email]
      user = USERS[email]
      user && { name: user[:name], role: user[:role], subject: email, authentication: "cookie" }
    end
    case SCENARIO
    when "no-provider" then nil
    when "rollback-failure" then bench.use FailingRollbackProvider.new(database: "fixture")
    else bench.use Sendproof::ActiveRecord::Provider.new(database: "fixture")
    end
    # Each store is hooked only when the runner passes its variables, so the standard and alternate
    # scenarios run without any store service.
    bench.data_store Sendproof::Mongoid::Store.new(name: "catalog") if STORES.include?(:mongodb)
    bench.data_store Sendproof::Redis::Store.new(name: "cache") if STORES.include?(:redis)
    bench.data_store Sendproof::DynamoDB::Store.new(client: DYNAMODB, name: "orders") if STORES.include?(:dynamodb)
    bench.data_store Sendproof::OpenSearch::Store.new(name: "search") if STORES.include?(:opensearch)

    initializer "fixture.database" do
      ActiveRecord::Schema.verbose = false
      ActiveRecord::Schema.define do
        create_table :items, id: false do |t|
          t.string :id, null: false, primary_key: true
          t.string :name, null: false
        end
        create_table :accounts, id: false do |t|
          t.string :id, null: false, primary_key: true
          t.string :email, null: false
          t.string :password_hash, null: false
        end
      end
      # mysql-escape: a procedure that commits. The fixture declares no procedure safe.
      if Fixture::MYSQL
        connection = ActiveRecord::Base.lease_connection
        exists = connection.select_value("SELECT COUNT(*) FROM information_schema.routines " \
                                         "WHERE routine_schema = DATABASE() AND routine_name = 'sendproof_commit_probe'")
        connection.execute("CREATE PROCEDURE sendproof_commit_probe() BEGIN COMMIT; END") if exists.to_i.zero?
      end
    end

    config.paths["config/routes.rb"] << File.expand_path("routes.rb", __dir__)
  end
end

Fixture::Application.initialize!
require_relative "controllers"
