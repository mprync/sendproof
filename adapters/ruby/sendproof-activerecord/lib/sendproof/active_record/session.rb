# frozen_string_literal: true

module Sendproof
  module ActiveRecord
    # One rollback-only preview: open non-joinable transactions on the handler's connections.
    #
    # Because the outer transaction is not joinable, the handler's own +transaction+ blocks become
    # savepoints and can neither commit nor leak it. Records never reach +after_commit+.
    class Session < Sendproof::Provider::PreviewSession
      Enrollment = Struct.new(:connection, :transaction)

      def initialize(tracker)
        super()
        @tracker = tracker
        @enrollments = []
        @rolled_back = false
        @closed = false
      end

      # Starts a transaction on +connection+; it is lazy, so no BEGIN is sent until the first statement.
      def enroll(connection)
        return if @enrollments.any? { |enrollment| enrollment.connection.equal?(connection) }

        @enrollments << Enrollment.new(connection, connection.begin_transaction(joinable: false))
      end

      def changes = @tracker.changes
      def changes_truncated? = @tracker.truncated?

      # Rolls back every enrolled transaction, then verifies none was committed.
      # @raise [RuntimeError] when a rollback is not confirmed
      def rollback!
        @tracker.freeze!
        failures = []
        @enrollments.reverse_each do |enrollment|
          rollback_one(enrollment)
        rescue StandardError => error
          failures << error
        end
        @rolled_back = failures.empty?
        raise failures.first, cause: failures.first if failures.any?
      end

      # Warns when write statements bypassed the model callbacks and so are missing from the diff.
      def finalize_capture(recorder)
        missed = @tracker.sql_writes - @tracker.tracked_writes
        return unless missed.positive?

        recorder.log(level: "Warning", category: "Sendproof",
                     message: "#{missed} write statement(s) bypassed model callbacks (update_all, delete_all, " \
                              "insert_all, touch or raw SQL). They were rolled back but are missing from the changes.")
      end

      def close
        return if @closed

        @closed = true
        begin
          @enrollments.reverse_each { |enrollment| rollback_one(enrollment) } unless @rolled_back
        ensure
          @tracker.deactivate
        end
      end

      private

      def rollback_one(enrollment)
        connection = enrollment.connection
        transaction = enrollment.transaction
        # A handler may leave nested transactions open after a crash; unwind them first.
        while connection.open_transactions.positive? && !connection.current_transaction.equal?(transaction)
          connection.rollback_transaction
        end
        connection.rollback_transaction(transaction) if connection.current_transaction.equal?(transaction)
        return if transaction.state.rolledback?

        raise "The #{transaction.state.class} transaction was not rolled back; the preview cannot be confirmed."
      end
    end
  end
end
