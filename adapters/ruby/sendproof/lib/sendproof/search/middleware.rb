# frozen_string_literal: true

module Sendproof
  module Search
    # Faraday middleware that hands each request to its store before the adapter sends it. It sits first
    # in the stack, so a request the guard refuses raises {Sendproof::PreviewWriteBlocked} and never
    # reaches the adapter, and no byte of it leaves the process.
    #
    # The middleware holds only the store's system id. It looks the store up on each request, so it does
    # nothing once its store was unhooked, and guards for the new one when another is registered.
    class Middleware < Faraday::Middleware
      # @param app [#call] the next middleware or the adapter
      # @param system [String] +"elasticsearch"+ or +"opensearch"+
      # @param prefix [String] the connection's path prefix, removed before classifying
      def initialize(app, system, prefix = "/")
        super(app)
        @system = system
        @prefix = prefix.to_s.chomp("/")
      end

      def call(env)
        store = Sendproof::Search.store(@system)
        return @app.call(env) unless store&.active?

        store.around(env.method, request_path(env), env.body) { @app.call(env) }
      end

      private

      # The request path without the connection's own prefix (for example +/search+ behind a proxy).
      def request_path(env)
        path = env.url.path
        return path if @prefix.empty?

        path == @prefix || path.start_with?("#{@prefix}/") ? path.delete_prefix(@prefix) : path
      end
    end
  end
end
