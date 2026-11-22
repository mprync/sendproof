# frozen_string_literal: true

module Sendproof
  module Firestore
    # The Firestore data store: a gRPC client interceptor ({Interceptor}) on every Firestore client's
    # channel. It classifies each call by RPC name before it is sent. Reads run and are logged as +Db+
    # entries. In a Preview the first write, a +Commit+ that carries writes, +BatchWrite+, +Write+ or a
    # document RPC, raises {Sendproof::PreviewWriteBlocked}, and the Preview answers 409. Nothing of the
    # call is sent. A Firestore transaction can be rolled back, but not for arbitrary handlers (it needs
    # every read before the first write), so the store always runs in +guard+ mode.
    #
    # +BeginTransaction+, +Rollback+ and a +Commit+ with no writes change no data and run unlogged.
    #
    # *Coverage.* Create the store before any Firestore client. From then on every client built, however
    # it is configured, gets the interceptor, because the hook sits where the gem creates the channel.
    # A client built earlier has no interceptor, so creating a store refuses (it raises) while one is
    # alive. Firestore over REST can't be guarded: with a store registered, building a REST client raises.
    #
    # @example
    #   config.sendproof.data_store Sendproof::Firestore::Store.new(name: "orders")
    class Store < Sendproof::DataStore
      # @param name [String, nil] display label for discovery, such as +orders+; never a project or URL
      # @param treat_as_read [Array<String>, nil] RPC names you state never write, matched exactly, such
      #   as a future read method. A wrongly listed write is not blocked.
      # @raise [Sendproof::ConfigurationError] when a Firestore client built earlier is alive, or a
      #   store is already registered
      def initialize(name: nil, treat_as_read: nil)
        super()
        @name = Stores::Guard.store_label(name)
        @reads = Stores::Guard.read_set(treat_as_read)
        @active = true
        Firestore.register(self)
        begin
          install_hooks
          refuse_live_clients
        rescue StandardError
          unhook!
          raise
        end
      end

      def system = "firestore"

      def describe
        { system: "firestore", name: @name, mode: :guard }
      end

      # Turns the guard off. Clients keep their interceptor, which then does nothing, and guards for the
      # next store registered.
      def unhook!
        @active = false
        Firestore.unregister(self)
      end

      # @return [Boolean] whether the guard is still on
      def active? = @active

      # Guards and logs one call around +block+, which sends it.
      #
      # @param rpc [String] the gRPC path, such as +/google.firestore.v1.Firestore/Commit+
      # @param message [Object, nil] the request message, when the call has one
      def around(rpc, message)
        return yield unless @active

        result = Stores::Classify.firestore(rpc, message, @reads)
        return yield if result.kind == :session

        Stores::Guard.guard("firestore", result.operation, result.kind)
        recorder = Capture.current
        return yield unless recorder

        fields = message.to_h if !message.nil? && message.respond_to?(:to_h)
        entry = { system: "firestore", operation: result.operation, target: collection_of(fields),
                  statement: fields && JSON.generate(Stores::Guard.sanitize_document(fields)) }
        started = Clock.now
        begin
          response = yield
        rescue StandardError => error
          recorder.db(**entry, error: error.class.name.to_s.split("::").last, duration_ms: Clock.elapsed_ms(started))
          raise
        end
        recorder.db(**entry, duration_ms: Clock.elapsed_ms(started))
        response
      end

      # Guards a write a +BulkWriter+ is about to queue, as the +BatchWrite+ it will be sent in. Called on
      # the handler's thread, so in a Preview the write is refused before the writer's threads see it.
      def guard_bulk_write
        return unless @active

        Stores::Guard.guard("firestore", "BatchWrite", Stores::Classify.firestore("BatchWrite", nil, @reads).kind)
      end

      private

      # Prepends the hooks that cover clients built later, once per process.
      def install_hooks
        ::Gapic::ServiceStub.prepend(StubHook) unless ::Gapic::ServiceStub < StubHook
        bulk = ::Google::Cloud::Firestore::BulkWriter
        bulk.prepend(BulkWriterHook) unless bulk < BulkWriterHook
        rest = rest_client_class
        rest.prepend(RestRefusal) if rest && !(rest < RestRefusal)
      end

      # A Firestore client built before this store has no interceptor and writes straight through.
      def refuse_live_clients
        # A REST client whose construction was refused never got a stub, so it is no live client.
        if rest_client_class && ObjectSpace.each_object(rest_client_class).any? { |client| client.instance_variable_defined?(:@firestore_stub) }
          raise ConfigurationError, RestRefusal::REASON
        end
        unguarded = ObjectSpace.each_object(::Gapic::ServiceStub).select do |stub|
          Firestore.firestore_stub?(stub_class_of(stub)) && !stub.instance_variable_get(:@sendproof_guarded)
        end
        return if unguarded.empty?

        raise ConfigurationError, "A Firestore client was built before this store, so its calls aren't guarded. " \
                                  "Create Sendproof::Firestore::Store before any Firestore client."
      end

      def rest_client_class
        ::Google::Cloud::Firestore::V1::Firestore::Rest::Client if defined?(::Google::Cloud::Firestore::V1::Firestore::Rest::Client)
      end

      # The generated gRPC stub class behind a +Gapic::ServiceStub+, single channel or pooled.
      def stub_class_of(stub)
        stub.instance_variable_get(:@grpc_stub)&.class ||
          stub.instance_variable_get(:@channel_pool)&.instance_variable_get(:@grpc_stub_class)
      end

      # The collection a request names, for +db.collection.name+: the query's collection, or the one a
      # document path in the message sits in.
      def collection_of(fields)
        return nil unless fields.is_a?(Hash)

        from = fields.dig(:structured_query, :from, 0, :collection_id) ||
               fields.dig(:structured_aggregation_query, :structured_query, :from, 0, :collection_id) ||
               fields.dig(:add_target, :query, :structured_query, :from, 0, :collection_id) ||
               fields[:collection_id]
        return from if from.is_a?(String) && !from.empty?

        name = fields.dig(:documents, 0) || fields.dig(:writes, 0, :update, :name) || fields.dig(:writes, 0, :delete) ||
               fields.dig(:add_target, :documents, :documents, 0) || fields[:name]
        segments = name.to_s.split("/documents/", 2)[1]&.split("/")
        return nil unless segments&.any?

        segments.length.even? ? segments[-2] : segments[-1]
      end
    end
  end
end
