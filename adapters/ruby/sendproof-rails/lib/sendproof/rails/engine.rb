# frozen_string_literal: true

module Sendproof
  module Rails
    # The Rails engine. Configure it with +config.sendproof+:
    #
    #   config.sendproof.environments = %w[development]
    #   config.sendproof.open_api_url = "/openapi.json"
    #   config.sendproof.identity = ->(request) { { name: ..., subject: ... } }
    #   config.sendproof.use Sendproof::ActiveRecord::Provider.new
    #
    # Nothing is served until +environments+ names the running environment.
    class Engine < ::Rails::Engine
      config.sendproof = Sendproof::Rails::Configuration.new

      initializer "sendproof.controller_hook" do
        ActiveSupport.on_load(:action_controller) { include Sendproof::Rails::Controller }
      end

      # Last in the stack: sessions, cookies and authentication middleware have already run, and
      # the next hop is the router, so a preview is routed and authorized exactly like a real call.
      initializer "sendproof.middleware" do |app|
        app.middleware.use Sendproof::Middleware, app.config.sendproof
      end

      initializer "sendproof.logging" do |app|
        Sendproof::Rails::LogSink.attach(app.config.sendproof)
      end
    end
  end
end
