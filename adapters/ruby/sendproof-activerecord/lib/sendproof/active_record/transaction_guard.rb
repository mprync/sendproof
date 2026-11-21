# frozen_string_literal: true

module Sendproof
  module ActiveRecord
    # Refuses, before it reaches the database, any statement a handler runs during a Preview that
    # would end or escape the Preview transaction: +COMMIT+, +END+, +ROLLBACK+ without +TO+,
    # +BEGIN+, +SET autocommit+ and, on MySQL and MariaDB, the statements that commit implicitly (the
    # shared +raw-commit+ rule, spec/data-stores.md). A refusal records a fault on the Preview, so it
    # answers 500 without confirmation even if the handler rescues the error.
    #
    # It sits on the adapter's lowest statement path, +raw_execute+, which +execute+, +exec_query+,
    # +select_all+ and every model query go through. Statements Rails itself issues to manage
    # transactions carry the name +TRANSACTION+ and pass, so savepoints and the Preview's own rollback
    # keep working. A statement sent on the driver's own handle (+raw_connection+) never reaches this
    # path and is not covered.
    module TransactionGuard
      # The adapters that are MySQL or MariaDB, which also commit implicitly.
      MYSQL_ADAPTERS = %w[mysql2 trilogy mysql].freeze

      private

      def raw_execute(sql, name = nil, *args, **options, &block)
        refuse_transaction_control(sql, name)
        begin
          super
        rescue StandardError => error
          notice_server_rollback(error)
          raise
        end
      end

      # A MySQL deadlock (1213), or a lock wait timeout (1205) with +innodb_rollback_on_timeout+ on, rolls
      # back the whole Preview transaction. Rails runs MySQL with autocommit on outside +BEGIN+, so every
      # later statement would commit for real: remember it, and refuse them all (see
      # {#refuse_transaction_control}). The handler still gets the original error.
      def notice_server_rollback(error)
        tracker = Tracker.current
        return if tracker.nil? || Sendproof::Capture.preview.nil? || tracker.ended(self)
        return unless MYSQL_ADAPTERS.include?(pool.db_config.adapter.to_s)

        code = server_error_code(error)
        reason = if code == 1213 || error.is_a?(::ActiveRecord::Deadlocked)
                   "a deadlock rolled back the Preview transaction"
                 elsif (code == 1205 || error.is_a?(::ActiveRecord::LockWaitTimeout)) && rollback_on_timeout?
                   "a lock wait timeout rolled back the Preview transaction"
                 end
        return unless reason

        tracker.end_transaction(self, reason)
        Sendproof::Capture.preview&.refuse(Sendproof::PreviewTransactionControl.new("The Preview can't be confirmed: #{reason}."))
      end

      def server_error_code(error)
        [error, error.cause].compact.each do |candidate|
          %i[error_code error_number errno].each do |reader|
            value = candidate.respond_to?(reader) ? candidate.public_send(reader) : nil
            return value if value.is_a?(Integer)
          end
        end
        nil
      end

      # Whether the server rolls back the whole transaction on a lock wait timeout; unknown counts as yes.
      def rollback_on_timeout?
        value = with_raw_connection { |connection| connection.query("SELECT @@innodb_rollback_on_timeout").to_a.dig(0, 0) }
        value.to_i == 1
      rescue StandardError
        true
      end

      def refuse_transaction_control(sql, name)
        tracker = Tracker.current
        return if name == "TRANSACTION" || tracker.nil?

        recorder = Sendproof::Capture.preview or return
        if (ended = tracker.ended(self))
          error = Sendproof::Stores::Guard.refuse_in_preview("Preview can't run this statement: #{ended}, so it would run outside the Preview transaction.")
          raise error if error
        end
        mysql = MYSQL_ADAPTERS.include?(pool.db_config.adapter.to_s)
        reason = Sendproof::TransactionControl.reason(sql, mysql: mysql, safe_procedures: tracker.safe_procedures,
                                                           reserved: Session::SAVEPOINT)
        return unless reason

        error = Sendproof::Stores::Guard.refuse_in_preview("Preview owns the database transaction, so #{reason}; it cannot run during Preview.")
        raise error if error && recorder
      end
    end
  end
end
