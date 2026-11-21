# frozen_string_literal: true

module Sendproof
  # State of one observed send (+Prefer: trace+): an ordinary request that also records a trace.
  #
  # Capture starts only at the endpoint handler, after the host authenticated and authorized the
  # request, and only for an authenticated subject admitted to the workbench.
  class ObservedRequest
    attr_reader :clock

    def initialize(config:, started: Clock.now)
      @config = config
      @clock = Clock::Request.new(started)
      @started = started
      @invoked = false
      @completed = false
      @reservation = nil
    end

    # Wraps the endpoint handler. See {Handler.around}.
    def around_handler(request:, eligible:, &block)
      return yield if @invoked || !eligible

      @invoked = true
      owner = owner_for(request)
      observation = owner && begin_observation(request)
      return yield unless observation

      @owner = owner
      @observation = observation
      @request = request
      @recorder = Recorder.new(rollback: false, started: @started, include_sql_values: @config.sql_parameter_values?)
      @reservation = @config.trace_store.reserve(owner)
      @clock.start_handler
      result = Capture.with(@recorder, &block)
      @completed = true
      result
    end

    # Completes the trace after the response is produced and adds the trace headers.
    #
    # @param headers [Hash, nil] Rack response headers to extend (nil when the app raised)
    # @param failed [Boolean] whether the application raised
    def finish(headers, failed: false)
      return unless @reservation

      @clock.end_handler
      completed = false
      begin
        completed = !failed && @completed && owner_for(@request) == @owner
        capture = Capture.with(@recorder) do
          @observation.finalize_capture(@recorder) if @observation.respond_to?(:finalize_capture)
          @recorder.finish
        end
        if completed
          started = Clock.now
          changes, truncated = Limits.snapshot_changes(@observation.changes)
          timing = @recorder.timing(@clock, Clock.elapsed_ms(started))
          trace = { changes:, effects: capture.effects, logs: capture.logs }
          trace[:changesTruncated] = true if truncated || @observation.changes_truncated?
          trace[:effectsTruncated] = true if capture.effects_truncated
          trace[:logsTruncated] = true if capture.logs_truncated
          trace[:timing] = timing
          @reservation.complete(trace)
          decorate(headers, timing) if headers
        end
      rescue StandardError => error
        completed = false
        warn_about("Sendproof could not collect the observed send", error)
      ensure
        @config.trace_store.discard(@reservation) unless completed
        release
      end
    end

    private

    def decorate(headers, timing)
      Protocol.set_header(headers, Protocol::TRACE_HEADER, @reservation.id)
      Protocol.set_header(headers, "cache-control", "no-store")
      Protocol.append_header(headers, "server-timing", Clock.server_timing(timing))
    end

    def owner_for(request)
      @config.identity_for(request)&.owner(request.script_name)
    end

    def begin_observation(request)
      return nil unless @config.authorized?(request)

      provider = @config.provider or return nil
      provider.begin_observation(ProviderContext.new(env: request.env, request:, config: @config))
    rescue StandardError => error
      warn_about("Sendproof could not start observing the send", error)
      nil
    end

    def release
      @observation&.close
    rescue StandardError => error
      warn_about("Sendproof could not release the send observation", error)
    end

    def warn_about(message, error)
      @config.logger&.warn("#{message}: #{error.class}: #{error.message}")
    end
  end
end
