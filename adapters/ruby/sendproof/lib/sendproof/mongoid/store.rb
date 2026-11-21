# frozen_string_literal: true

module Sendproof
  module Mongoid
    # The MongoDB data store for Mongoid. See {Sendproof::Mongo::Store} for the plain driver.
    #
    # On a replica set or sharded cluster a Preview runs every Mongoid operation in one transaction that is
    # aborted afterwards, and reports document changes. On a standalone server the store runs in +guard+
    # mode: reads run and the first write blocks the Preview.
    #
    # Mongoid operations that bypass the model layer, such as +Model.collection.insert_one+, carry no
    # session, so the engine refuses them and the Preview answers 500 rather than claim a rollback.
    class Store < Sendproof::DataStore
      # @return [Sendproof::Mongo::Engine]
      attr_reader :engine

      # @param client [Symbol, String] the Mongoid client name to hook (+:default+)
      # @param name [String, nil] display label for discovery, such as +catalog+; never a connection string or host
      # @param treat_as_read [Array<String>, nil] commands you state never write, by exact name
      # @param preview_timeout [Numeric] seconds a Preview may hold its transaction (default 50)
      # @param hello [#call, nil] test seam: returns the +hello+ document instead of asking the server
      def initialize(client: :default, name: nil, treat_as_read: nil, preview_timeout: Sendproof::Mongo::Engine::DEFAULT_TIMEOUT, hello: nil)
        super()
        @name = Stores::Guard.store_label(name)
        reads = Stores::Guard.read_set(treat_as_read, &:downcase)
        @client_name = client
        @engine = Sendproof::Mongo::Engine.new(::Mongoid::Clients.with_name(client), reads: reads, preview_timeout: preview_timeout, hello: hello)
        Sendproof::Mongoid.install!
      end

      def system = "mongodb"

      def describe
        { system: "mongodb", name: @name, **@engine.detect }
      end

      # Refuses to start when Mongoid now uses a client the store never hooked (one it built after
      # +Mongoid::Clients.clear+): that client's writes would be neither guarded nor rolled back.
      def begin_preview(_context, recorder)
        if @engine.active? && !@engine.hooked?(::Mongoid::Clients.with_name(@client_name))
          raise ConfigurationError, "Mongoid rebuilt its #{@client_name.inspect} client after Sendproof hooked it; " \
                                    "create the Sendproof::Mongoid::Store after Mongoid's clients are configured."
        end

        @engine.begin_preview(recorder)
      end

      def finish_preview(recorder) = @engine.finish_preview(recorder)

      # Turns the hook off: nothing is guarded or logged afterwards.
      def unhook! = @engine.unhook!
    end
  end
end
