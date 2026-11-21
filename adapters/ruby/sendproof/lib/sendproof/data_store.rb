# frozen_string_literal: true

module Sendproof
  # Base class and contract for a data-store hook (spec/data-stores.md). Register one with
  # {Configuration#data_store}. Subclassing is optional; any object with these methods works.
  #
  # A store runs in one of two modes. +:preview+ stores join the Preview: their writes run in a
  # transaction the hook aborts after the handler. +:guard+ stores can't roll back: reads run and
  # the first write blocks the Preview before any byte of it reaches the store.
  class DataStore
    # @return [String] the store id: +"mongodb"+, +"redis"+ or +"dynamodb"+
    def system
      raise NotImplementedError, "#{self.class} must implement system"
    end

    # What capabilities +dataStores+ lists for this store.
    # @return [Hash] +:system+, +:mode+ (+:preview+ or +:guard+), optionally +:name+ and +:reason+
    def describe
      raise NotImplementedError, "#{self.class} must implement describe"
    end

    # Prepares a Preview before the handler runs: a +preview+-mode store starts its session and
    # transaction here. Runs with the preview's recorder current.
    # @param context [ProviderContext]
    # @param recorder [Recorder]
    def begin_preview(_context, _recorder); end

    # Finishes a Preview after the handler and before SQL rolls back: captures changes, then aborts
    # the store's transaction. Raise when it can't be proven aborted; the Preview then answers 500.
    # Must be safe to call when {#begin_preview} failed or never ran.
    # @param recorder [Recorder]
    def finish_preview(_recorder); end
  end
end
