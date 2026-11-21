# frozen_string_literal: true

module TestBench
  module ActiveRecord
    # Collects model changes for one preview or observed send on the current thread.
    class Tracker
      KEY = :testbench_active_record_tracker

      # @return [Tracker, nil] the tracker active on this thread
      def self.current = Thread.current[KEY]

      attr_reader :sql_writes, :tracked_writes

      def initialize
        @mutex = Mutex.new
        @changes = []
        @frozen = false
        @truncated = false
        @sql_writes = 0
        @tracked_writes = 0
        @previous = nil
      end

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
