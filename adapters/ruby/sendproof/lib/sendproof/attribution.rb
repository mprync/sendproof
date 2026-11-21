# frozen_string_literal: true

module Sendproof
  # Which request a data-store write belongs to, and what happens to a write that belongs to none.
  #
  # A store hook finds its request through {Capture}, which is thread- and fiber-local: a write sent from
  # a thread or fiber the handler started carries no request. The guard can't block it and MongoDB can't
  # put it in the Preview transaction, so it runs. While any Preview is open, such a write therefore fails
  # every open Preview with 500, so none confirms a rollback that didn't happen (spec/data-stores.md, "a
  # confirmed Preview never leaves a write behind").
  #
  # A write is attributed when it runs inside a Preview or observed send, inside any request that passed
  # through {Middleware}, or inside {Sendproof.detached}, the mark for background work such as a job
  # worker running in the same process.
  module Attribution
    KEY = :sendproof_attribution

    @open = {}.compare_by_identity
    @lock = Mutex.new

    class << self
      # Marks the block as a request {Middleware} handles, so its writes never fail a Preview.
      def request(&) = mark(:request, &)

      # Marks the block as work that belongs to no request (see {Sendproof.detached}).
      def detached(&) = mark(:detached, &)

      # @return [Boolean] whether a write sent now belongs to a request, or was marked detached
      def attributed? = !Capture.current.nil? || !Thread.current[KEY].nil?

      # Registers a Preview for the time its handler and cleanup run.
      # @param recorder [Recorder]
      def open(recorder)
        @lock.synchronize { @open[recorder] = true }
      end

      # Removes a Preview registered with {open}.
      def close(recorder)
        @lock.synchronize { @open.delete(recorder) }
      end

      # Called by a store hook for each write it lets through. An unattributed write sent while a
      # Preview is open fails every open Preview.
      #
      # @param store [String] the store id, such as +"redis"+
      # @param operation [String] the command or action name
      def report_write(store, operation)
        return if @open.empty? || attributed?

        message = "A #{Stores::Guard.store_name(store)} #{operation} was sent outside any request while this Preview ran " \
                  "(from a thread or fiber the handler started, or from background work). Sendproof can't tell it apart " \
                  "from the Preview's own writes, so the Preview can't be confirmed. Mark background work with Sendproof.detached."
        open = @lock.synchronize { @open.keys }
        open.each { |recorder| recorder.refuse(PreviewTransactionControl.new(message)) }
      end

      private

      def mark(kind)
        previous = Thread.current[KEY]
        Thread.current[KEY] = kind
        yield
      ensure
        Thread.current[KEY] = previous
      end
    end
  end
end
