# frozen_string_literal: true

module Sendproof
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

    def initialize(app, config, sessions)
      @app = app
      @config = config
      @sessions = sessions
    end

    # @param env [Hash] the Rack environment of the +/sendproof/_preview/...+ request
    # @param prefix [Integer] index of the reserved prefix in PATH_INFO
    # @return [Array] Rack response
    def call(env, request, prefix)
      id = env[PreviewSessions::HEADER]
      return PreviewSessions.not_found if id && !Protocol.same_origin?(request)

      if id
        return denied(request) unless @config.authorized?(request)

        return @sessions.with_session(request, id) { |session| preview(env, request, prefix, session) }
      end
      preview(env, request, prefix)
    end

    private

    def preview(env, request, prefix, held = nil)
      started = Clock.now
      path = env["PATH_INFO"].to_s
      rejection = precheck(env, request, path, prefix, held)
      return rejection if rejection.is_a?(Array)

      rewritten = path[0, prefix] + path[(prefix + Protocol::PREFIX.length)..]
      resolution = if held && request.get?
                     @config.resolve_session_get(rewritten, env)
                   else
                     @config.resolve_target(request.request_method, rewritten, env)
                   end
      return Protocol.problem(404, "The preview target was not found for this method.") if resolution.nil?
      return Protocol.problem(409, "This operation is unavailable for preview.") if resolution == :ineligible
      return execute_held(env, request, held, rewritten, started) if held

      provider = @config.preview_provider
      return Protocol.problem(503, "Preview requires one available preview provider.") unless provider

      execute(env, request, provider, rewritten, started)
    end

    def precheck(env, request, path, prefix, held)
      return Protocol.problem(400, "A Sendproof preview requires Prefer: tx=rollback.") unless Protocol.exact_preference?(env)
      return Protocol.problem(405, "A preview requires a response body.") if request.head?

      target = path[(prefix + Protocol::PREFIX.length)..]
      if target.empty? || target.start_with?("//") || bench_target?(target) || !valid_target?(target)
        return Protocol.problem(400, "The Sendproof preview target is invalid.")
      end
      return if held # The outer request already passed admission and ownership checks.

      return Protocol.problem(403, "A preview must come from the application's own origin.") unless Protocol.same_origin?(request)
      return denied(request) unless @config.authorized?(request)

      nil
    end

    def denied(request)
      @config.identity_for(request) ? Protocol.problem(403, "This preview is forbidden.") :
        Protocol.problem(401, "Authentication is required for this preview.")
    end

    def bench_target?(target)
      target.casecmp?("/sendproof") || target.downcase.start_with?("/sendproof/")
    end

    def valid_target?(target)
      decoded = Rack::Utils.unescape_path(target)
      decoded.valid_encoding? && !decoded.start_with?("//") && !decoded.include?("\\") &&
        decoded.match?(/\A[^[:cntrl:]]*\z/) && decoded.split("/").none? { |segment| [".", ".."].include?(segment) }
    rescue ArgumentError
      false
    end

    # Runs one preview in the order spec/data-stores.md fixes: begin the SQL transaction and each
    # store, run the handler, finish every store (capture changes, abort its transaction), then roll
    # back SQL. Afterwards a failed step or a recorded fault answers 500, a refused write answers 409,
    # and only then is the preview confirmed.
    def execute(env, request, provider, rewritten, started)
      recorder = Recorder.new(rollback: true, started:, include_sql_values: @config.sql_parameter_values?)
      preview = PreviewRequest.new(recorder:, clock: Clock::Request.new(started))
      failure = nil         # a begin, finish or rollback step failed: nothing can be confirmed
      handler_failure = nil # the handler raised, or its response was unusable
      response = nil
      envelope = nil
      context = ProviderContext.new(env:, request:, config: @config)
      escaped = nil # an error that isn't a StandardError (a timeout, an interrupt): re-raised after cleanup

      # While it is open, a store write that belongs to no request fails this Preview (see {Attribution}).
      Attribution.open(recorder)
      begin
        Capture.with(recorder) do
          begin
            preview.session = provider.begin_preview(context)
            raise "The preview provider returned no session." unless preview.session

            @config.data_stores.each { |store| store.begin_preview(context, recorder) if store.respond_to?(:begin_preview) }
            response, handler_failure = dispatch(env, rewritten, preview)
          rescue StandardError => error
            failure = combine(failure, error)
          rescue Exception => error # rubocop:disable Lint/RescueException -- stores and SQL must still be aborted
            # rack-timeout, Timeout and Interrupt unwind with errors outside StandardError. Skipping the steps
            # below would leave a store transaction open and the SQL connection (and its MySQL turn) held.
            escaped = error
            failure = combine(failure, error)
          end

          # Every store finishes before the SQL rollback, and one that fails, however it fails, never stops
          # the others or the rollback.
          @config.data_stores.each do |store|
            store.finish_preview(recorder) if store.respond_to?(:finish_preview)
          rescue StandardError => error
            failure = combine(failure, error)
          rescue Exception => error # rubocop:disable Lint/RescueException -- the rollback must still run
            escaped ||= error
            failure = combine(failure, error)
          end

          if (session = preview.session)
            begin
              session.rollback!
              session.finalize_capture(recorder) if session.respond_to?(:finalize_capture)
              if failure.nil? && handler_failure.nil? && preview.completed? && response && !recorder.fault && !recorder.blocked
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
      ensure
        Attribution.close(recorder)
      end
      raise escaped if escaped

      preview.clock.end_handler
      skip_session_commit(env)

      outcome(request, preview, response, failure, handler_failure, recorder, envelope)
    end

    # Each request gets a new recorder; only the stores' transactions and rewind points survive it.
    def execute_held(env, request, held, rewritten, started)
      recorder = Recorder.new(rollback: true, started:, include_sql_values: @config.sql_parameter_values?)
      preview = PreviewRequest.new(recorder:, clock: Clock::Request.new(started), session_get: request.get?)
      context = ProviderContext.new(env:, request:, config: @config)
      sql = held.sql
      preview.session = sql
      Attribution.open(recorder)
      Capture.with(recorder) do
        sql.begin_step(held.next_step)
        held.stores.each { |store| store.begin_step(held.next_step, recorder) }
        begin
          held.guards.each do |store|
            store.begin_preview(context, recorder) if store.respond_to?(:begin_preview)
            raise PreviewSessions::StoreEnded unless store.describe[:mode].to_s == "guard"
          end
          response, handler_failure = dispatch(env, rewritten, preview)
          preview.clock.end_handler
        ensure
          finish_guards(held.guards, recorder)
        end
        held.stores.each { |store| store.capture_step(recorder) }
        sql.finalize_capture(recorder) if sql.respond_to?(:finalize_capture)
        raise recorder.fault if recorder.fault

        if handler_failure || !preview.completed? || response.nil? || response.status >= 500 || recorder.blocked
          held.undo_step
          handler_failure ||= RuntimeError.new("The preview handler returned a server error.") if response && response.status >= 500
          return outcome(request, preview, response, nil, handler_failure, recorder, nil)
        end

        sql.keep_step
        reply = serialize(response, sql, recorder.finish, preview, session: { id: held.id, step: held.next_step })
        held.advance
        reply
      end
    rescue PreviewSessions::StepUndone => error
      held.undo_step
      outcome(request, preview, nil, error, nil, recorder, nil)
    ensure
      skip_session_commit(env)
      recorder.finish if recorder.active?
      Attribution.close(recorder)
    end

    def finish_guards(guards, recorder)
      failure = nil
      guards.each do |store|
        store.finish_preview(recorder) if store.respond_to?(:finish_preview)
      rescue Exception => error # every guard gets its finish call even if another unwound
        failure ||= error
      end
      raise failure if failure
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
      inner.delete(PreviewSessions::HEADER)
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

    def outcome(request, preview, response, failure, handler_failure, recorder, envelope)
      fault = failure || recorder.fault
      if fault
        log_failure(request, fault)
        return Protocol.problem(500, "The preview could not be completed safely.")
      end
      # The refused-write mark decides, whatever the handler did with the error or returned.
      return blocked_response(recorder.blocked) if recorder.blocked

      if handler_failure
        log_failure(request, handler_failure)
        return handler_failure.is_a?(ResponseTooLarge) ? too_large : Protocol.problem(500, "The preview could not be completed safely.")
      end
      return reject_unexecuted(preview, response) unless envelope

      response, session, capture = envelope
      serialize(response, session, capture, preview)
    end

    def log_failure(request, failure)
      @config.logger&.error("A Sendproof preview failed for #{request.request_method} #{request.path}: " \
                            "#{failure.class}: #{failure.message}")
    end

    # The blocked-Preview response of spec/data-stores.md: 409 problem+json, never a confirmation. It
    # carries nothing the handler produced and names the command, never its arguments.
    def blocked_response(blocked)
      body = JSON.generate({ type: "about:blank", title: "Preview unavailable", status: 409, code: "preview_unavailable",
                             detail: blocked.detail, store: blocked.store, operation: blocked.operation, rolledBack: false })
      [409, { "content-type" => "application/problem+json", "cache-control" => "no-store",
              "content-length" => body.bytesize.to_s }, [body]]
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

    def serialize(response, provider_session, capture, preview, session: nil)
      changes, truncated = Limits.snapshot_changes(provider_session.changes + capture.changes)
      headers = response.headers.reject { |name, _| Protocol::PRIVATE_HEADERS.include?(name) || name.length > Limits::NAME }
                        .first(Limits::PARAMETERS).to_h { |name, value| [name, Limits.clip(value)] }
      document = { status: response.status, headers:, body: read_body(response), changes:,
                   effects: capture.effects, logs: capture.logs, rolledBack: true }
      document[:session] = session if session
      document[:changesTruncated] = true if truncated || provider_session.changes_truncated? || capture.changes_truncated
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
