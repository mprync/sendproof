# frozen_string_literal: true

module Sendproof
  module ActiveRecord
    # Turns +sql.active_record+ notifications into captured SQL log entries, redacting secrets.
    module SqlSubscriber
      WRITE = /\A\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/i
      IGNORED_NAMES = %w[SCHEMA TRANSACTION].freeze

      module_function

      def subscribe
        ActiveSupport::Notifications.subscribe("sql.active_record") { |event| handle(event) }
      end

      def handle(event)
        recorder = Capture.current or return
        payload = event.payload
        return if payload[:cached] || IGNORED_NAMES.include?(payload[:name])

        text = payload[:sql].to_s
        Tracker.current&.sql_write! if text.match?(WRITE)
        recorder.record_sql(duration_ms: event.duration, category: "ActiveRecord") do
          snapshot(text, payload, recorder.include_sql_values?)
        end
      end

      # @return [Array(Hash, Boolean)] the captured SQL and whether anything was truncated
      def snapshot(text, payload, show_values)
        binds = Array(payload[:binds])
        # Placeholders carry no column information, so one secret-looking name hides every value, and a
        # statement that names a secret is shown without its literals: a database without prepared
        # statements (MySQL) inlines values into the text instead of binding them.
        redact_all = !show_values || Redaction.looks_secret?(text)
        text = Redaction.mask_literals(text) if redact_all
        clipped = Limits.clip(text)
        values = payload[:type_casted_binds]
        values = values.call if values.respond_to?(:call)
        values = Array(values)
        truncated = clipped.length != text.length || binds.length > Limits::PARAMETERS

        parameters = binds.first(Limits::PARAMETERS).each_with_index.map do |bind, index|
          name = bind.respond_to?(:name) && bind.name ? bind.name.to_s : "p#{index}"
          redact = redact_all || Redaction.looks_secret?(name)
          value = redact ? Redaction::REDACTED : parameter_value(values[index])
          { name: Limits.clip(name, Limits::NAME), value: value, dbType: db_type(bind) }
        end
        [{ text: clipped, parameters: parameters }, truncated]
      end

      def parameter_value(value)
        return nil if value.nil?
        return Limits.clip(value.unpack1("H*"), Limits::TEXT) if value.is_a?(String) && value.encoding == Encoding::BINARY

        text = value.respond_to?(:iso8601) ? value.iso8601(6) : value.to_s
        Limits.clip(text)
      rescue ArgumentError
        Limits.clip(value.to_s)
      end

      def db_type(bind)
        type = bind.respond_to?(:type) ? bind.type : nil
        (type.respond_to?(:type) && type.type ? type.type : type.class.name.to_s.split("::").last).to_s.downcase
      end
    end
  end
end
