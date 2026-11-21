# frozen_string_literal: true

module Sendproof
  # Monotonic time helpers and the per-request phase clock behind Server-Timing.
  module Clock
    module_function

    # @return [Float] monotonic seconds
    def now
      Process.clock_gettime(Process::CLOCK_MONOTONIC)
    end

    # @return [Float] milliseconds since +started+
    def elapsed_ms(started, finished = now)
      (finished - started) * 1000.0
    end

    # Records when a request began and when its handler ran, to report the auth, handler and serialize phases.
    class Request
      attr_reader :started

      def initialize(started = Clock.now)
        @started = started
        @handler_start = nil
        @handler_end = nil
      end

      def start_handler
        @handler_start ||= Clock.now
      end

      def end_handler
        @handler_end ||= Clock.now
      end

      # @return [Hash] auth, handler, db, queryCount and serialize
      def read(db_ms, queries, serialize_ms, extra_serialize_ms = 0.0)
        handler_start = @handler_start || @started
        handler_end = @handler_end || Clock.now
        {
          auth: Clock.elapsed_ms(@started, handler_start),
          handler: [0.0, Clock.elapsed_ms(handler_start, handler_end) - db_ms - serialize_ms].max,
          db: db_ms, queryCount: queries, serialize: serialize_ms + extra_serialize_ms
        }
      end
    end

    # @return [String] the Server-Timing header value for a timing hash
    def server_timing(timing)
      format('auth;dur=%<auth>.3f, handler;dur=%<handler>.3f, db;dur=%<db>.3f;desc="%<queryCount>d queries", ' \
             "serialize;dur=%<serialize>.3f", timing)
    end
  end
end
