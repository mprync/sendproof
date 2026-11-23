# frozen_string_literal: true

module Sendproof
  module ActiveRecord
    # Collects model changes for one preview or observed send on the current thread.
    class Tracker
      KEY = :sendproof_active_record_tracker

      # @return [Tracker, nil] the tracker active on this thread
      def self.current = Thread.current[KEY]

      attr_reader :sql_writes, :tracked_writes

      # @return [Array<String>] the procedures the host declared never commit (see {Provider#initialize})
      attr_reader :safe_procedures

      def initialize(safe_procedures: [], connections: nil)
        @safe_procedures = safe_procedures
        @connections = connections
        @ended = {}.compare_by_identity
        @mutex = Mutex.new
        @changes = []
        @frozen = false
        @truncated = false
        @sql_writes = 0
        @tracked_writes = 0
        @previous = nil
      end

      def holds?(connection) = @connections.nil? || @connections.include?(connection)

      # Records that the server itself ended the Preview transaction on +connection+ (a MySQL deadlock).
      def end_transaction(connection, reason)
        @mutex.synchronize { @ended[connection] ||= reason }
      end

      # @return [String, nil] why the server ended the Preview transaction on +connection+, if it did
      def ended(connection) = @mutex.synchronize { @ended[connection] }

      # Makes this tracker current on the calling thread.
      def activate
        @previous = Thread.current[KEY]
        Thread.current[KEY] = self
      end

      def deactivate
        Thread.current[KEY] = @previous if Thread.current[KEY].equal?(self)
      end

      # Stops further changes from being recorded or removed (so the final rollback cannot erase the diff).
      def freeze!
        @mutex.synchronize { @frozen = true }
      end

      # @return [Array<Hash>] changes in the order they happened
      def changes
        @mutex.synchronize { @changes.map { |entry| entry[:change] } }
      end

      def truncated? = @mutex.synchronize { @truncated }

      def truncate!
        @mutex.synchronize { @truncated = true }
      end

      def sql_write!
        @mutex.synchronize { @sql_writes += 1 }
      end

      # Records a change made by +record+.
      def record(record, change)
        @mutex.synchronize do
          return if @frozen

          @tracked_writes += 1
          if @changes.length >= Limits::CHANGES
            @truncated = true
          else
            @changes << { record: record, change: change }
          end
        end
      end

      # Forgets changes of +record+ after its transaction rolled back (a savepoint, or the request's own).
      def rolled_back(record)
        @mutex.synchronize do
          return if @frozen

          @changes.reject! { |entry| entry[:record].equal?(record) }
        end
      end
    end
  end
end
