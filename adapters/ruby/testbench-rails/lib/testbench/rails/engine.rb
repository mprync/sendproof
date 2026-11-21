# frozen_string_literal: true

module TestBench
  module Rails
    # The Rails engine. Configure it with +config.test_bench+:
    #
    #   config.test_bench.environments = %w[development]
    #   config.test_bench.open_api_url = "/openapi.json"
    #   config.test_bench.identity = ->(request) { { name: ..., subject: ... } }
    #   config.test_bench.use TestBench::ActiveRecord::Provider.new
    #
    # Nothing is served until +environments+ names the running environment.
    class Engine < ::Rails::Engine
      config.test_bench = TestBench::Rails::Configuration.new

      initializer "test_bench.controller_hook" do
        ActiveSupport.on_load(:action_controller) { include TestBench::Rails::Controller }
      end

      # Last in the stack: sessions, cookies and authentication middleware have already run, and
      # the next hop is the router, so a preview is routed and authorized exactly like a real call.
      initializer "test_bench.middleware" do |app|
        app.middleware.use TestBench::Middleware, app.config.test_bench
      end

      initializer "test_bench.logging" do |app|
        TestBench::Rails::LogSink.attach(app.config.test_bench)
      end
    end
  end
end
