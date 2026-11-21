# frozen_string_literal: true

require "logger"

module TestBench
  module Rails
    # A logger that copies Rails.logger entries into the active capture.
    # It is attached by broadcast, so existing log destinations are unchanged.
    class LogSink < ::Logger
      LEVELS = { DEBUG => "Debug", INFO => "Information", WARN => "Warning", ERROR => "Error",
                 FATAL => "Critical", UNKNOWN => "Information" }.freeze

      # Attaches a sink to Rails.logger when the workbench is enabled and the logger can broadcast.
      def self.attach(config)
        return unless config.enabled?

        logger = ::Rails.logger
        return unless logger.respond_to?(:broadcast_to)

        sink = new(nil)
        sink.level = config.log_level
        logger.broadcast_to(sink)
      end

      def add(severity, message = nil, progname = nil)
        severity ||= UNKNOWN
        return true if severity < level

        recorder = TestBench::Capture.current or return true
        # Logger#info("text") passes the text as the progname; with a block, progname is the category.
        if message.nil?
          message = block_given? ? yield : progname
          progname = nil if !block_given?
        end
        error = message if message.is_a?(Exception)
        text = error ? "#{error.class}: #{error.message}" : message.to_s
        recorder.log(level: LEVELS.fetch(severity, "Information"), message: text.strip, exception: error,
                     category: progname.is_a?(String) ? progname : nil)
        true
      end
    end
  end
end
