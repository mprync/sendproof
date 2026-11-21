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
        super
      end

      def refuse_transaction_control(sql, name)
        tracker = Tracker.current
        return if name == "TRANSACTION" || tracker.nil?

        recorder = Sendproof::Capture.preview or return
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
