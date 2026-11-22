# frozen_string_literal: true

module Sendproof
  # Which request a data-store write belongs to, and what happens to a write that belongs to none.
  #
  # A store hook finds its request through {Capture}, which is thread- and fiber-local: a write sent from
  # a thread or fiber the handler started, or from a client's own background threads (Firestore's
  # +BulkWriter+), carries no request. While any Preview is open such a write is treated as that Preview's
  # write: it is refused before it is sent, and every open Preview is blocked, or for a +preview+-mode
  # store fails with 500 (spec/data-stores.md, "Writes the binding can't attribute to a request").
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

      # Called by a store hook, before it sends, for each write outside a Preview. A write that belongs to
      # no request while a Preview is open is refused: every open Preview is marked blocked (409), or with
      # +fault: true+, for a +preview+-mode store, fails with 500, and the error is raised so the write is
      # never sent. Does nothing for an attributed write or when no Preview is open.
      #
      # @param store [String] the store id, such as +"redis"+
      # @param operation [String] the command or action name
      # @param fault [Boolean] fail the open Previews with 500 instead of blocking them
      # @raise [PreviewWriteBlocked, PreviewTransactionControl] when the write is refused
      def refuse_unattributed(store, operation, fault: false)
        return if attributed?

        open = @lock.synchronize { @open.keys }
        return if open.empty?

        why = "A #{Stores::Guard.store_name(store)} #{operation} was sent outside any request while a Preview ran " \
              "(from a thread or fiber the handler started, or from background work), so Sendproof refused it: it can't " \
              "tell it apart from the Preview's own writes. Mark background work with Sendproof.detached."
        if fault
          open.each { |recorder| recorder.refuse(PreviewTransactionControl.new(why)) }
          raise PreviewTransactionControl, why
        end

        reason = Stores::Guard.write_reason(store)
        open.each do |recorder|
          recorder.block(store: store, operation: operation, detail: reason)
          recorder.db(system: store, operation: operation, blocked: true)
        end
        raise PreviewWriteBlocked.new(store, operation, "#{reason}. #{why}")
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
