# frozen_string_literal: true

require "faraday"
require "sendproof"

module Sendproof
  # Shared by the Elasticsearch and OpenSearch write guards (spec/data-stores.md, +guard+ mode). Both
  # clients send every request through a Faraday connection, so one middleware, {Middleware}, sees the
  # method, path and body of every call before the adapter sends it.
  #
  # Require {Sendproof::Elasticsearch} or {Sendproof::OpenSearch}, not this file.
  module Search
    autoload :Middleware, "sendproof/search/middleware"
    autoload :Store, "sendproof/search/store"

    @stores = {}
    @mutex = Mutex.new

    class << self
      # The store guarding +system+ (+"elasticsearch"+ or +"opensearch"+), or +nil+. The middleware asks
      # on every request, so replacing a store never leaves connections pointing at an old one.
      def store(system) = @mutex.synchronize { @stores[system] }

      # Registers +store+ as the one guarding its system.
      # @raise [ConfigurationError] when another store is already guarding that system
      def register(store)
        @mutex.synchronize do
          current = @stores[store.system]
          if current&.active?
            raise ConfigurationError, "A #{Stores::Guard.store_name(store.system)} store is already registered; call unhook! on it first."
          end

          @stores[store.system] = store
        end
      end

      # Removes +store+ from the registry, if it is the registered one.
      def unregister(store) = @mutex.synchronize { @stores.delete(store.system) if @stores[store.system].equal?(store) }

      # The active store whose transport class is the one of +transport+.
      def store_for_transport(transport)
        @mutex.synchronize { @stores.values.find { |store| store.active? && store.transport_class === transport } }
      end

      # Called by {BuildHook} after the HTTP transport built a Faraday connection: adds the guard to it
      # when a store covers that transport. Runs for the first build and for every rebuild (sniffing,
      # reloading), so a rebuilt connection is never left bare.
      def guard_connection(transport, faraday)
        store_for_transport(transport)&.cover(transport, faraday)
      end

      # Called by {ClientHook} after a transport client was built: a client the guard can't cover
      # (another HTTP transport than Faraday) fails its construction when a global store is active.
      def verify_client(client)
        store = @mutex.synchronize { @stores.values.find { |s| s.active? && s.global? && s.client_class === client } }
        store&.verify(client)
      rescue ConfigurationError
        client.transport = nil # a client that failed to build is unusable; later checks skip it
        raise
      end
    end

    # Prepended to an HTTP transport class: every Faraday connection it builds gets the guard, whether
    # built at startup or later by sniffing or reloading.
    module BuildHook
      def __build_connection(host, options = {}, block = nil)
        connection = super
        Sendproof::Search.guard_connection(self, connection.connection)
        connection
      end
    end

    # Prepended to a transport client class: a client built after a global store was registered is
    # checked for a transport the guard can cover.
    module ClientHook
      ruby2_keywords def initialize(*args, &block)
        super
        Sendproof::Search.verify_client(self)
      end
    end
  end
end
