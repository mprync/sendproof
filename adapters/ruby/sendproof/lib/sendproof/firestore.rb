# frozen_string_literal: true

require "grpc"
require "gapic/grpc"
require "google/cloud/firestore"
require "sendproof"

module Sendproof
  # Sendproof write guard for Google Cloud Firestore (spec/data-stores.md, +guard+ mode), for the
  # +google-cloud-firestore+ gem over gRPC and every generated Firestore client under it.
  #
  #   store = Sendproof::Firestore::Store.new(name: "orders")   # create it before any Firestore client
  #   config.sendproof.data_store store
  #
  # Require it explicitly: +require "sendproof/firestore"+. It needs no Firestore server.
  #
  # A gRPC client interceptor sees every call before it is sent, unary or streaming, which is why the
  # hook sits there: +Write+ is a bidirectional stream and a unary-only hook would let it through.
  module Firestore
    autoload :Interceptor, "sendproof/firestore/interceptor"
    autoload :Store, "sendproof/firestore/store"

    @store = nil
    @mutex = Mutex.new

    class << self
      # The store guarding Firestore, or +nil+. The interceptor asks on every call, so replacing a store
      # never leaves a client pointing at an old one.
      def store = @mutex.synchronize { @store }

      # Registers +store+ as the one guarding Firestore.
      # @raise [ConfigurationError] when another store is already guarding it
      def register(store)
        @mutex.synchronize do
          raise ConfigurationError, "A Firestore store is already registered; call unhook! on it first." if @store&.active?

          @store = store
        end
      end

      # Removes +store+ from the registry, if it is the registered one.
      def unregister(store) = @mutex.synchronize { @store = nil if @store.equal?(store) }

      # Whether a gRPC stub class belongs to a Firestore client (the data or admin API).
      def firestore_stub?(grpc_stub_class) = grpc_stub_class.respond_to?(:name) && grpc_stub_class.name.to_s.start_with?("Google::Cloud::Firestore::")
    end

    # Prepended to +Gapic::ServiceStub+, the one place every generated Google client gets its gRPC channel.
    # While a store is registered it adds the guard interceptor to each Firestore stub, however the client
    # was configured: a host that replaces +config.interceptors+ can't drop it. A stub built with no store
    # registered is not guarded, and the next store refuses to start while one is alive.
    module StubHook
      def initialize(grpc_stub_class, **options)
        if Sendproof::Firestore.store&.active? && Sendproof::Firestore.firestore_stub?(grpc_stub_class)
          @sendproof_guarded = true
          options[:interceptors] = [Sendproof::Firestore::Interceptor.new, *Array(options[:interceptors])]
        end
        super
      end
    end

    # Prepended to +Google::Cloud::Firestore::BulkWriter+. A BulkWriter sends from threads of its own, which
    # carry no request, and retries a failed batch without end, so the guard runs as the handler queues
    # each write instead: in a Preview the write is refused before it is queued.
    module BulkWriterHook
      def create(...)
        Sendproof::Firestore.store&.guard_bulk_write
        super
      end

      def set(...)
        Sendproof::Firestore.store&.guard_bulk_write
        super
      end

      def update(...)
        Sendproof::Firestore.store&.guard_bulk_write
        super
      end

      def delete(...)
        Sendproof::Firestore.store&.guard_bulk_write
        super
      end
    end

    # Prepended to the REST clients, which have no interceptor and so can't be guarded: with a store
    # registered, building one fails instead of leaving writes unguarded.
    module RestRefusal
      REASON = "Sendproof can't guard Firestore over REST. Use the default gRPC transport."

      def initialize(*, **)
        raise ConfigurationError, REASON if Sendproof::Firestore.store&.active?

        super
      end
    end
  end
end
