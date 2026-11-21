# frozen_string_literal: true

module Sendproof
  module ActiveRecord
    # Captures model changes of an ordinary send. It never touches the transaction.
    class Observation < Sendproof::Provider::Observation
      def initialize(tracker)
        super()
        @tracker = tracker
        @tracker.activate
      end

      def changes = @tracker.changes
      def changes_truncated? = @tracker.truncated?

      def finalize_capture(recorder)
        missed = @tracker.sql_writes - @tracker.tracked_writes
        return unless missed.positive?

        recorder.log(level: "Warning", category: "Sendproof",
                     message: "#{missed} write statement(s) bypassed model callbacks and are missing from the changes.")
      end

      def close
        @tracker.freeze!
        @tracker.deactivate
      end
    end
  end
end
