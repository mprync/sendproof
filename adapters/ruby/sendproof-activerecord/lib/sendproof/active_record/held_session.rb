# frozen_string_literal: true

module Sendproof
  module ActiveRecord
    # The session worker keeps these Rails connection leases until every transaction has rolled back.
    class HeldSession < Session
      CHECK = "sendproof_check"
      RESERVED = /sendproof_(?:preview|check|step_\d+)/i
      CHECKOUT_LIMIT = 1

      # Rails' lease API calls checkout without a timeout. Bound just that checkout on this worker
      # while leaving the pool's settings and other requests' checkout behavior intact.
      module Checkout
        def checkout(timeout = checkout_timeout)
          timeout = [timeout, CHECKOUT_LIMIT].min if Thread.current[:sendproof_held_checkout]
          super(timeout)
        end
      end

      def initialize(classes, safe_procedures, label, release_turn:)
        super(Tracker.new(safe_procedures:), release_turn:)
        @safe_procedures = safe_procedures
        @pools = []
        classes.each do |klass|
          pool = klass.connection_pool
          next if @pools.include?(pool)

          @pools << pool
          connection = lease(pool)
          if pool.db_config.adapter.to_s == "sqlite3"
            enroll_sqlite(connection, pool.db_config.configuration_hash, File.basename(pool.db_config.database))
          else
            enroll(connection)
          end
        end
      rescue ::ActiveRecord::ConnectionTimeoutError, ::ActiveRecord::LockWaitTimeout
        close
        raise PreviewSessions::StoreBusy, label || "the database"
      rescue Exception # release successfully acquired leases if a later enrollment fails
        close
        raise
      end

      def begin_step(step)
        @tracker = Tracker.new(safe_procedures: @safe_procedures, connections: @enrollments.map(&:connection))
        @tracker.activate
        each_connection do |connection|
          connection.create_savepoint(step_name(step))
          connection.create_savepoint(CHECK)
        end
      end

      def finalize_capture(recorder)
        @tracker.freeze!
        super
      ensure
        @tracker.deactivate
      end

      def keep_step
        each_connection { |connection| connection.release_savepoint(CHECK) }
      rescue ::ActiveRecord::StatementInvalid => error
        # A caught PostgreSQL error leaves the transaction aborted. The worker tries a rewind
        # on every store. A missing savepoint makes the whole session unsafe instead.
        raise PreviewSessions::StepUndone, error.message
      end

      def rewind(step)
        each_connection do |connection|
          savepoint = step_name(step)
          connection.exec_rollback_to_savepoint(savepoint)
          connection.release_savepoint(savepoint)
          connection.clear_query_cache
        end
      end

      def close
        return if @closed

        super
      ensure
        failures = []
        @pools.reverse_each do |pool|
          connection = pool.active_connection?
          if @enrollments.any? { |item| item.connection.equal?(connection) && !item.transaction.state.rolledback? }
            pool.remove(connection)
            connection.disconnect!
          else
            pool.release_connection
          end
        rescue StandardError => error
          failures << error
        end
        @pools.clear
        raise failures.first if failures.any?
      end

      private

      def lease(pool)
        Thread.current[:sendproof_held_checkout] = true
        pool.lease_connection
      ensure
        Thread.current[:sendproof_held_checkout] = nil
      end

      def each_connection
        @enrollments.each do |item|
          raise PreviewSessions::StoreEnded if @tracker.ended(item.connection)
          unless item.connection.current_transaction.equal?(item.transaction)
            raise "The ActiveRecord connection no longer holds the Preview transaction."
          end

          yield item.connection
        end
      end

      def step_name(step) = "sendproof_step_#{step}"

      def enroll_sqlite(connection, settings, label)
        raw = connection.raw_connection
        raw.busy_handler_timeout = 200
        begin
          enroll(connection)
          # Rails begins non-joinable SQLite transactions deferred. Writing the same header
          # value acquires the write lock without touching host tables or changing the version.
          version = Integer(connection.select_value("PRAGMA main.user_version"))
          connection.execute("PRAGMA main.user_version = #{version}")
        ensure
          if settings[:retries]
            retries = Integer(settings[:retries])
            raw.busy_handler { |count| count <= retries }
          else
            raw.busy_handler_timeout = Integer(settings.fetch(:timeout, 0))
          end
        end
      rescue ::ActiveRecord::StatementInvalid => error
        raise unless [error, error.cause].any? { |cause| %w[SQLite3::BusyException SQLite3::LockedException].include?(cause.class.name) }

        raise PreviewSessions::StoreBusy, label
      end
    end
  end
end
