# frozen_string_literal: true

module Sendproof
  # Rack middleware that adds the workbench, preview transport and observed sends to an application.
  #
  #   use Sendproof::Middleware, environment: ENV["RACK_ENV"], environments: %w[development],
  #                              open_api_url: "/openapi.json", identity: ->(request) { ... }
  #
  # Place it after session and authentication middleware and before the router, so the preview
  # request is routed, authenticated and authorized by the host exactly like a real call.
  class Middleware
    # @param config [Configuration, nil] a shared configuration; otherwise built from +options+
    def initialize(app, config = nil, **options)
      @app = app
      @config = config || Configuration.new(**options)
      @config.validate!
      @sessions = PreviewSessions.new(@config)
      @workbench = Workbench.new(@config, @sessions)
      @preview = PreviewTransport.new(app, @config, @sessions)
    end

    def close = @sessions.shutdown

    def call(env)
      return @app.call(env) unless @config.enabled?

      # Every request seen here is attributed: its store writes never fail another request's Preview.
      Attribution.request { dispatch(env) }
    end

    private

    def dispatch(env)
      request = Rack::Request.new(env)
      path = env["PATH_INFO"].to_s
      prefix = reserved_index(path)
      return @preview.call(env, request, prefix) if prefix

      if Protocol.requests_rollback?(env)
        return Protocol.problem(400, "Use the Sendproof preview URL for rollback requests.")
      end
      return @workbench.call(env, request, path) if path == "/sendproof" || path.start_with?("/sendproof/")

      call_observed(env, request)
    end

    # Index of +/sendproof/_preview+ when it is a whole path segment, comparing case-insensitively.
    def reserved_index(path)
      index = path.downcase.index(Protocol::PREFIX)
      return nil unless index

      stop = index + Protocol::PREFIX.length
      index if stop == path.length || path[stop] == "/"
    end

    def call_observed(env, request)
      return @app.call(env) if request.head? || !Protocol.requests_trace?(env) || !Protocol.same_origin?(request)

      observed = ObservedRequest.new(config: @config)
      env[ENV_KEY] = observed
      begin
        status, headers, body = @app.call(env)
      rescue Exception # rubocop:disable Lint/RescueException -- the trace must be discarded for any unwinding
        observed.finish(nil, failed: true)
        raise
      end
      observed.finish(headers)
      [status, headers, body]
    end
  end
end
