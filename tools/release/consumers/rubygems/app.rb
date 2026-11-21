# frozen_string_literal: true

# Minimal Rails API that mounts the Sendproof workbench the way the gem READMEs describe.
# Used only by tools/release/rubygems.mjs to prove the packed gems install and serve /sendproof/.
require "json"
require "rails"
require "action_controller/railtie"
require "active_record/railtie"
require "sendproof/rails"
require "sendproof/active_record"

ENV["DATABASE_URL"] = "sqlite3::memory:"

class ConsumerApp < Rails::Application
  config.load_defaults 8.0
  config.api_only = true
  config.eager_load = false
  config.enable_reloading = false
  config.secret_key_base = "release-smoke-test-only-secret-key-base"
  config.hosts.clear
  config.root = __dir__
  config.logger = ActiveSupport::BroadcastLogger.new(ActiveSupport::Logger.new($stderr, level: :warn))

  config.sendproof.environments = %w[development]
  config.sendproof.api_name = "Release smoke test"
  config.sendproof.open_api_url = "/openapi.json"
  config.sendproof.use Sendproof::ActiveRecord::Provider.new(database: "smoke")

  OPENAPI = JSON.generate(
    openapi: "3.0.3",
    info: { title: "Release smoke test", version: "1.0.0" },
    paths: { "/ping" => { get: { operationId: "ping", responses: { "200" => { description: "pong" } } } } }
  )

  routes.append do
    get "/openapi.json", to: ->(_env) { [200, { "content-type" => "application/json" }, [OPENAPI]] }
    get "/ping", to: ->(_env) { [200, { "content-type" => "text/plain" }, ["pong"]] }
  end
end

ConsumerApp.initialize!
