# frozen_string_literal: true

module Sendproof
  module Mongo
    # The MongoDB data store for the plain +mongo+ driver.
    #
    #   catalog = Sendproof::Mongo::Store.new(Mongo::Client.new(url), name: "catalog")
    #   config.sendproof.data_store catalog
    #   catalog.client[:documents].insert_one(...)   # handlers use catalog.client
    #
    # On a replica set or sharded cluster a Preview runs in a transaction that is aborted afterwards; on
    # a standalone server the store runs in +guard+ mode and the first write blocks the Preview.
    class Store < Sendproof::DataStore
      # @return [Object] the guarded client handlers must use: same API, Preview session added during a Preview
      attr_reader :client
      # @return [Engine]
      attr_reader :engine

      # @param client [Mongo::Client] the driver client to hook
      # @param name [String, nil] display label for discovery, such as +catalog+; never a connection string or host
      # @param treat_as_read [Array<String>, nil] commands you state never write, by exact name (compared
      #   case-insensitively, as MongoDB does). A wrongly listed write is not blocked in +guard+ mode.
      # @param preview_timeout [Numeric] seconds a Preview may hold its transaction (default 50, below the
      #   server's 60-second lifetime); a Preview still running at the limit answers 500
      # @param hello [#call, nil] test seam: returns the +hello+ document instead of asking the server
      def initialize(client, name: nil, treat_as_read: nil, preview_timeout: Engine::DEFAULT_TIMEOUT, hello: nil)
        super()
        unless client.is_a?(::Mongo::Client)
          raise ArgumentError, "Sendproof::Mongo::Store takes a Mongo::Client from the mongo driver."
        end

        @name = Stores::Guard.store_label(name)
        reads = Stores::Guard.read_set(treat_as_read, &:downcase)
        @engine = Engine.new(client, reads: reads, preview_timeout: preview_timeout, hello: hello)
        @client = Guarded::Handle.new(client, @engine)
      end

      def system = "mongodb"

      def describe
        { system: "mongodb", name: @name, **@engine.detect }
      end

      def begin_preview(_context, recorder) = @engine.begin_preview(recorder)

      def finish_preview(recorder) = @engine.finish_preview(recorder)

      # Turns the hook off: nothing is guarded or logged afterwards.
      def unhook! = @engine.unhook!
    end
  end
end
