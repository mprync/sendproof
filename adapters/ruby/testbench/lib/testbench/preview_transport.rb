# frozen_string_literal: true

module TestBench
  # Runs a request through the application's real middleware and handler, then rolls it back
  # and answers with a confirmed envelope (preview.schema.json).
  #
  # Nothing here returns a successful envelope unless the endpoint handler ran to completion,
  # the provider confirmed the rollback, and the buffered response stayed within its limit.
  class PreviewTransport
    # The inner response exceeded {Limits::RESPONSE_BYTES}.
    class ResponseTooLarge < StandardError; end

    # Result of draining the inner response body.
    Response = Struct.new(:status, :headers, :body)

    def initialize(app, config)
      @app = app
      @config = config
    end

    # @param env [Hash] the Rack environment of the +/bench/_preview/...+ request
    # @param prefix [Integer] index of the reserved prefix in PATH_INFO
    # @return [Array] Rack response
    def call(env, request, prefix)
      started = Clock.now
      path = env["PATH_INFO"].to_s
      rejection = precheck(env, request, path, prefix)
      return rejection if rejection.is_a?(Array)

      rewritten = path[0, prefix] + path[(prefix + Protocol::PREFIX.length)..]
      resolution = @config.resolve_target(request.request_method, rewritten, env)
      return Protocol.problem(404, "The preview target was not found for this method.") if resolution.nil?
      return Protocol.problem(409, "This operation is unavailable for preview.") if resolution == :ineligible

      provider = @config.provider
      return Protocol.problem(503, "Preview requires one available preview provider.") unless provider

      execute(env, request, provider, rewritten, started)
    end

    private

    def precheck(env, request, path, prefix)
      return Protocol.problem(400, "A Test Bench preview requires Prefer: tx=rollback.") unless Protocol.exact_preference?(env)
      return Protocol.problem(405, "A preview requires a response body.") if request.head?

      target = path[(prefix + Protocol::PREFIX.length)..]
      if target.empty? || target.start_with?("//") || bench_target?(target) || !valid_target?(target)
        return Protocol.problem(400, "The Test Bench preview target is invalid.")
      end
      return Protocol.problem(403, "A preview must come from the application's own origin.") unless Protocol.same_origin?(request)
      return denied(request) unless @config.authorized?(request)

      nil
    end

    def denied(request)
      @config.identity_for(request) ? Protocol.problem(403, "This preview is forbidden.") :
        Protocol.problem(401, "Authentication is required for this preview.")
    end

    def bench_target?(target)
      target.casecmp?("/bench") || target.downcase.start_with?("/bench/")
    end

    def valid_target?(target)
      decoded = Rack::Utils.unescape_path(target)
      decoded.valid_encoding? && !decoded.start_with?("//") && !decoded.include?("\\") &&
        decoded.match?(/\A[^[:cntrl:]]*\z/) && decoded.split("/").none? { |segment| [".", ".."].include?(segment) }
    rescue ArgumentError
      false
    end

    def execute(env, request, provider, rewritten, started)
      recorder = Recorder.new(rollback: true, started:, include_sql_values: @config.sql_parameter_values?)
      preview = PreviewRequest.new(recorder:, clock: Clock::Request.new(started))
      failure = nil
      response = nil
      envelope = nil

      Capture.with(recorder) do
        begin
          preview.session = provider.begin_preview(ProviderContext.new(env:, request:, config: @config))
          raise "The preview provider returned no session." unless preview.session

          response, failure = dispatch(env, rewritten, preview)
        rescue StandardError => error
          failure = combine(failure, error)
        end

        if (session = preview.session)
          begin
            session.rollback!
            session.finalize_capture(recorder) if session.respond_to?(:finalize_capture)
            if failure.nil? && preview.completed? && response
              envelope = [response, session, recorder.finish]
            end
          rescue StandardError => error
            failure = combine(failure, error)
          ensure
            recorder.finish if recorder.active?
            begin
              session.close
            rescue StandardError => error
              failure = combine(failure, error)
            end
          end
        end
      end
      preview.clock.end_handler
      skip_session_commit(env)

      outcome(request, preview, response, failure, envelope)
    end

    # Runs the inner request. Returns the buffered response and any failure.
    def dispatch(env, rewritten, preview)
      inner = inner_env(env, rewritten, preview)
      begin
        status, headers, body = @app.call(inner)
        [drain(status, headers, body), nil]
      rescue ResponseTooLarge => error
        [nil, error]
      rescue IneligibleHandler
        [nil, nil]
      rescue StandardError => error
        mapped = @config.status_for_error(error)
        return [nil, error] unless mapped

        preview.complete! if preview.invoked?
        [handled_error(mapped), nil]
      end
    end

    def handled_error(status)
      title = Rack::Utils::HTTP_STATUS_CODES[status] || "Error"
      Response.new(status, { "content-type" => "application/problem+json" },
                   JSON.generate({ type: "about:blank", title:, status: }))
    end

    # The environment the application sees: the original request at its real path, with caches
    # from the outer request cleared so routing and parameters are computed again.
    def inner_env(env, rewritten, preview)
      inner = env.dup
      inner.delete_if do |key, _|
        key.start_with?("action_dispatch.request.", "rack.request.query", "rack.request.form") ||
          %w[action_dispatch.cookies action_dispatch.route_uri_pattern rack.hijack rack.upgrade].include?(key)
      end
      inner["PATH_INFO"] = rewritten
      query = env["QUERY_STRING"].to_s
      full = env["SCRIPT_NAME"].to_s + rewritten + (query.empty? ? "" : "?#{query}")
      inner["REQUEST_PATH"] = env["SCRIPT_NAME"].to_s + rewritten if env.key?("REQUEST_PATH")
      inner["REQUEST_URI"] = full if env.key?("REQUEST_URI")
      inner["ORIGINAL_FULLPATH"] = full if env.key?("ORIGINAL_FULLPATH")
      inner["rack.hijack?"] = false
      inner.delete("HTTP_ACCEPT_ENCODING")
      inner["HTTP_CACHE_CONTROL"] = "no-cache, no-store"
      inner["rack.input"].rewind if inner["rack.input"].respond_to?(:rewind)
      inner[ENV_KEY] = preview
      inner
    end

    # The preview must not persist the session or write cookies on the real response.
    def skip_session_commit(env)
      options = env["rack.session.options"]
      options[:skip] = true if options.respond_to?(:[]=)
    end

    def drain(status, headers, body)
      buffer = String.new(encoding: Encoding::BINARY)
      append = lambda do |chunk|
        buffer << chunk.to_s
        raise ResponseTooLarge if buffer.bytesize > Limits::RESPONSE_BYTES
      end
      begin
        if body.respond_to?(:each)
          body.each(&append)
        elsif body.respond_to?(:call)
          body.call(BoundedStream.new(append))
        end
      ensure
        body.close if body.respond_to?(:close)
      end
      Response.new(status.to_i, normalize(headers), buffer)
    end

    def normalize(headers)
      headers.each_with_object({}) do |(name, value), result|
        result[name.to_s.downcase] = Array(value).join(", ")
      end
    end

    def outcome(request, preview, response, failure, envelope)
      if failure
        @config.logger&.error("A Test Bench preview failed for #{request.request_method} #{request.path}: " \
                              "#{failure.class}: #{failure.message}")
        return failure.is_a?(ResponseTooLarge) ? too_large : Protocol.problem(500, "The preview could not be completed safely.")
      end
      return reject_unexecuted(preview, response) unless envelope

      response, session, capture = envelope
      serialize(response, session, capture, preview)
    end

    def too_large = Protocol.problem(413, "The preview response exceeds the 1 MiB limit.")

    def reject_unexecuted(preview, response)
      return Protocol.problem(500, "The preview operation did not finish.") if preview.invoked?
      return Protocol.problem(409, "This operation is unavailable for preview.") if preview.rejected? || response.nil?

      status = response.status
      title = case status
              when 401 then "Authentication is required for this preview."
              when 403 then "This preview is forbidden."
              when 404, 405 then "The preview target was not found for this method."
              when 503 then "Preview requires one available preview provider."
              when 300...400 then "Preview redirects are disabled. Sign in through the workbench first."
              when 400...500 then status == 409 ? "This operation is unavailable for preview." : "The host rejected the preview request."
              else "This operation is unavailable for preview."
              end
      status = status.between?(300, 399) ? 401 : 409 if status < 400 || (status >= 500 && status != 503)
      extra = {}
      challenge = response.headers["www-authenticate"]
      extra["www-authenticate"] = challenge if challenge
      Protocol.problem(status, title, extra)
    end

    def serialize(response, session, capture, preview)
      changes, truncated = Limits.snapshot_changes(session.changes)
      headers = response.headers.reject { |name, _| Protocol::PRIVATE_HEADERS.include?(name) || name.length > Limits::NAME }
                        .first(Limits::PARAMETERS).to_h { |name, value| [name, Limits.clip(value)] }
      document = { status: response.status, headers:, body: read_body(response), changes:,
                   effects: capture.effects, logs: capture.logs, rolledBack: true }
      document[:changesTruncated] = true if truncated || session.changes_truncated?
      document[:effectsTruncated] = true if capture.effects_truncated
      document[:logsTruncated] = true if capture.logs_truncated
      started = Clock.now
      json = JSON.generate(document)
      timing = preview.recorder.timing(preview.clock, Clock.elapsed_ms(started))
      [200, { "content-type" => Protocol::JSON_TYPE, "cache-control" => "no-store",
              "preference-applied" => Protocol::ROLLBACK_PREFERENCE,
              "server-timing" => Clock.server_timing(timing), "content-length" => json.bytesize.to_s }, [json]]
    end

    # JSON bodies are parsed, text is returned as a string and anything else is base64.
    def read_body(response)
      bytes = response.body
      return nil if bytes.empty?

      type = response.headers["content-type"].to_s.split(";", 2).first.to_s.strip.downcase
      text = bytes.dup.force_encoding(Encoding::UTF_8)
      if type == "application/json" || type.end_with?("+json")
        begin
          return JSON.parse(text)
        rescue JSON::ParserError
          return text.scrub
        end
      end
      return text.scrub if type.empty? || type.start_with?("text/")

      [bytes].pack("m0")
    end

    def combine(previous, error)
      previous.nil? ? error : error.tap { |e| e.define_singleton_method(:cause) { previous } }
    end

    # Receives the chunks of a streaming (+call+) Rack body.
    class BoundedStream
      def initialize(sink) = @sink = sink
      def write(chunk) = (@sink.call(chunk); chunk.to_s.bytesize)
      def <<(chunk) = (write(chunk); self)
      def flush = self
      def close = nil
      def closed? = false
    end
  end
end
