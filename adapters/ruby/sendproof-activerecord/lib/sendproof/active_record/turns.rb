# frozen_string_literal: true

module Sendproof
  module ActiveRecord
    # Lets MySQL and MariaDB Previews run one at a time in each process.
    #
    # InnoDB checks a new key for duplicates under a shared lock. When three or more transactions
    # insert the same key and the first one rolls back, as every Preview does, the waiters each hold
    # that shared lock and each need the exclusive one, so InnoDB aborts all but one with a deadlock
    # (error 1213). Sent for real, the first insert would commit and the others would get a
    # duplicate-key error instead. No isolation level avoids it, so a Preview takes its provider's turn
    # before it leases a connection and hands the turn back once its transaction has ended, as SQLite
    # Previews already queue behind +BEGIN IMMEDIATE+. Previews sent to different processes still run
    # at the same time. Sends and observed sends never wait.
    class Turns
      def initialize
        @mutex = Mutex.new
      end

      # Waits for the turn and returns a callable that hands it back (idempotent).
      # @return [#call]
      def take
        @mutex.lock
        release
      end

      def try_take
        release if @mutex.try_lock
      end

      private

      def release
        released = false
        lambda do
          next if released

          released = true
          @mutex.unlock
        end
      end
    end
  end
end
