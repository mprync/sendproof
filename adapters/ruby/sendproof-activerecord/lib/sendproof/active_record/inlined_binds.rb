# frozen_string_literal: true

module Sendproof
  module ActiveRecord
    # Keeps the binds an adapter without prepared statements inlines into the SQL text, so the SQL log
    # can still report them by name and redact them.
    #
    # Trilogy (and any connection inside +unprepared_statement+) compiles a query with Arel's
    # +SubstituteBinds+ collector, which quotes each bind into the text: the +sql.active_record+ event then
    # carries no binds, and a secret-named bind such as +api_token+ would show its value in the text
    # whenever the statement itself doesn't name a secret. This module records the binds the collector
    # substitutes while a capture runs, and {SqlSubscriber} attaches them to the event for the same text.
    module InlinedBinds
      KEY = :sendproof_inlined_binds
      COLLECTOR = :sendproof_substitute_collector

      # Records what the collector substitutes.
      module Recording
        def add_bind(bind, &)
          sendproof_binds << bind
          super
        end

        def add_binds(binds, proc_for_binds = nil, &)
          sendproof_binds.concat(binds)
          super
        end

        def sendproof_binds = @sendproof_binds ||= []
      end

      # Returns the binds inlined into +sql+, the text of the statement about to be logged, once.
      # @return [Array, nil]
      def self.take(sql)
        entry = Thread.current[KEY] or return nil
        return nil unless sql.to_s.include?(entry.first)

        Thread.current[KEY] = nil
        entry.last
      end

      def to_sql_and_binds(arel_or_sql_string, binds = [], *rest)
        return super if prepared_statements || Sendproof::Capture.current.nil?

        Thread.current[COLLECTOR] = nil
        result = super
        collector = Thread.current[COLLECTOR]
        Thread.current[KEY] = [result.first.to_s, collector.sendproof_binds.dup] if collector && !collector.sendproof_binds.empty?
        result
      ensure
        Thread.current[COLLECTOR] = nil
      end

      private

      def collector
        super.tap do |collector|
          if collector.is_a?(::Arel::Collectors::SubstituteBinds) && Sendproof::Capture.current
            collector.extend(Recording)
            Thread.current[COLLECTOR] = collector
          end
        end
      end
    end
  end
end
