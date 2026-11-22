# frozen_string_literal: true

module Sendproof
  # Which request a data-store write belongs to, and what happens to a write that belongs to none.
  #
  # A store hook finds its request through {Capture}, which is thread- and fiber-local: a write sent from
  # a thread or fiber the handler started, or from a client's own background threads (Firestore's
  # +BulkWriter+), carries no request. While any Preview is open such a write is treated as that Preview's
  # write: it is refused before it is sent, and every open Preview is blocked (409) whatever the store's
  # mode (spec/data-stores.md, "Writes the binding can't attribute to a request").
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
      # no request while a Preview is open is refused, and the error is raised so the write is never sent.
      # Every open Preview is marked blocked (409), whatever the store's mode: nothing reached the store, so
      # there is nothing a rollback could have missed. Does nothing for an attributed write or when no
      # Preview is open.
      #
      # @param store [String] the store id, such as +"redis"+
      # @param operation [String] the command or action name
      # @raise [PreviewWriteBlocked] when the write is refused
      def refuse_unattributed(store, operation)
        return if attributed?

        inherited = Capture.inherited_preview
        return refuse_inherited(inherited, store, operation) if inherited

        open = @lock.synchronize { @open.keys }
        return if open.empty?

        why = "A #{Stores::Guard.store_name(store)} #{operation} was sent outside any request while a Preview ran " \
              "(from a thread or fiber the handler started, or from background work), so Sendproof refused it: it can't " \
              "tell it apart from the Preview's own writes. Mark background work with Sendproof.detached."
        reason = Stores::Guard.write_reason(store)
        open.each do |recorder|
          recorder.block(store: store, operation: operation, detail: reason)
          recorder.db(system: store, operation: operation, blocked: true)
        end
        raise PreviewWriteBlocked.new(store, operation, "#{reason}. #{why}")
      end

      private

      # A write from a thread or fiber a Preview's handler started: it is that Preview's write. While the
      # Preview is open it blocks it (409); once it ended, it is refused for as long as the thread lives,
      # since nothing could take it back.
      def refuse_inherited(recorder, store, operation)
        reason = Stores::Guard.write_reason(store)
        if recorder.active?
          recorder.block(store: store, operation: operation, detail: reason)
          recorder.db(system: store, operation: operation, blocked: true)
          raise PreviewWriteBlocked.new(store, operation, "#{reason}. It was sent from a thread or fiber the Preview's handler started.")
        end

        why = "A #{Stores::Guard.store_name(store)} #{operation} was sent from a thread or fiber a Preview's handler started, " \
              "after that Preview ended, so Sendproof refused it. Mark background work with Sendproof.detached."
        raise PreviewWriteBlocked.new(store, operation, "#{reason}. #{why}")
      end

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
