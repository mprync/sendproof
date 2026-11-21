# frozen_string_literal: true

module Sendproof
  module ActiveRecord
    # One rollback-only preview: open non-joinable transactions on the handler's connections.
    #
    # Because the outer transaction is not joinable, the handler's own +transaction+ blocks become
    # savepoints and can neither commit nor leak it. Records never reach +after_commit+.
    class Session < Sendproof::Provider::PreviewSession
      # @!attribute marked [Boolean] whether the transaction opened with {SAVEPOINT} (MySQL and MariaDB)
      Enrollment = Struct.new(:connection, :transaction, :marked)

      # The savepoint every Preview opens its transaction with, for the backstop in
      # {#rollback!}. Rails names its own savepoints +active_record_<n>+, so it never makes this one, and
      # the {TransactionGuard} refuses a handler's +RELEASE+ or +ROLLBACK TO+ of it like a +COMMIT+.
      SAVEPOINT = "sendproof_preview"

      # @param release_turn [#call, nil] hands the provider's MySQL turn back (see {Turns})
      def initialize(tracker, release_turn: nil)
        super()
        @tracker = tracker
        @release_turn = release_turn
        @enrollments = []
        @rolled_back = false
        @closed = false
      end

      # Starts a transaction on +connection+ and opens it at once with {SAVEPOINT}, the backstop's mark
      # (on every database: a commit the guard can't see erases it).
      def enroll(connection)
        return if @enrollments.any? { |enrollment| enrollment.connection.equal?(connection) }

        enrollment = Enrollment.new(connection, connection.begin_transaction(joinable: false), false)
        @enrollments << enrollment
        connection.create_savepoint(SAVEPOINT) # materializes the BEGIN first
        enrollment.marked = true
      end

      def changes = @tracker.changes
      def changes_truncated? = @tracker.truncated?

      # Rolls back every enrolled transaction, then verifies none was committed.
      # @raise [RuntimeError] when a rollback is not confirmed
      def rollback!
        @tracker.freeze!
        failures = []
        @enrollments.reverse_each do |enrollment|
          check_still_open(enrollment, failures)
          rollback_one(enrollment)
        rescue StandardError => error
          failures << error
        end
        @rolled_back = failures.empty?
        raise failures.first, cause: failures.first if failures.any?

        # The transaction has ended with the rollback, so the next MySQL Preview may run. A failed
        # rollback keeps the turn until +close+ has tried again.
        hand_back_turn
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
          unless @rolled_back
            # Every connection is retried: one that fails again never leaves the others in a transaction.
            failures = []
            @enrollments.reverse_each do |enrollment|
              rollback_one(enrollment)
            rescue StandardError => error
              failures << error
            end
            raise failures.first if failures.any?
          end
        ensure
          @tracker.deactivate
          hand_back_turn
        end
      end

      private

      # The backstop, on every database: the savepoint the Preview transaction opened with must still
      # exist. Any commit, explicit or implicit, erases every savepoint, and the driver (or MySQL with
      # autocommit off) may then open a new transaction by itself, so a savepoint made now would prove nothing. Error 1305
      # (SAVEPOINT does not exist), or a lost connection, means the rollback can't be confirmed; the
      # rollback itself still runs.
      def check_still_open(enrollment, failures)
        return unless enrollment.marked

        enrollment.connection.exec_rollback_to_savepoint(SAVEPOINT)
      rescue StandardError => error
        failures << RuntimeError.new("The Preview transaction was committed before its rollback (its savepoint is gone: " \
                                     "#{error.class}), so the Preview can't be confirmed.")
      end

      def hand_back_turn
        release = @release_turn
        @release_turn = nil
        release&.call
      end

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
