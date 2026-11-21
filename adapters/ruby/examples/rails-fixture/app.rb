# frozen_string_literal: true

# The Test Bench conformance fixture: a disposable Rails API backed by one real SQLite table.
# It doubles as the reference setup for testbench-rails and testbench-activerecord.
#
# Environment: PORT (set by the server), BENCH_PATH_BASE (see config.ru), BENCH_SCENARIO
# (standard, disabled, no-provider or rollback-failure).

require "tmpdir"
require "fileutils"
require "rails"
require "action_controller/railtie"
require "active_record/railtie"
require "testbench/rails"
require "testbench/active_record"

# Every process gets its own empty database file, removed on exit.
DATABASE_DIRECTORY = Dir.mktmpdir("testbench-fixture-")
at_exit { FileUtils.remove_entry(DATABASE_DIRECTORY, true) }
ENV["DATABASE_URL"] = "sqlite3:#{File.join(DATABASE_DIRECTORY, 'fixture.sqlite3')}?timeout=5000&pool=8"

module Fixture
  SCENARIO = ENV.fetch("BENCH_SCENARIO", "standard")
  PASSWORD = "bench-fixture"
  USERS = {
    "admin@example.test" => { name: "Fixture Admin", role: "admin" },
    "viewer@example.test" => { name: "Fixture Viewer", role: "viewer" }
  }.freeze

  # Raised from a rollback to prove the transport withholds confirmation.
  class InjectedRollbackFailure < StandardError; end

  # Same provider, but its rollback reports a failure after the transaction was really rolled back.
  class FailingRollbackProvider < TestBench::ActiveRecord::Provider
    def begin_preview(context)
      super.tap do |session|
        session.define_singleton_method(:rollback!) do
          super()
          raise InjectedRollbackFailure, "injected rollback failure"
        end
      end
    end
  end

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
    config.logger = ActiveSupport::BroadcastLogger.new(ActiveSupport::Logger.new($stderr, level: :info))
    config.root = __dir__

    # Cookie sessions, as a real login would use. They run before Test Bench in the stack.
    config.middleware.use ActionDispatch::Cookies
    config.middleware.use ActionDispatch::Session::CookieStore, key: "_fixture_session", same_site: :lax

    bench = config.test_bench
    bench.environments = SCENARIO == "disabled" ? %w[staging] : [Rails.env]
    bench.api_name = "Test Bench Conformance"
    bench.open_api_url = "/openapi/v1.json"
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
    else bench.use TestBench::ActiveRecord::Provider.new(database: "fixture")
    end

    initializer "fixture.database" do
      ActiveRecord::Schema.verbose = false
      ActiveRecord::Schema.define do
        create_table :items, id: false do |t|
          t.string :id, null: false, primary_key: true
          t.string :name, null: false
        end
      end
    end

    config.paths["config/routes.rb"] << File.expand_path("routes.rb", __dir__)
  end
end

Fixture::Application.initialize!
require_relative "controllers"
