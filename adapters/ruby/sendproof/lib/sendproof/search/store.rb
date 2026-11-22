# frozen_string_literal: true

module Sendproof
  module Search
    # The write guard shared by {Sendproof::Elasticsearch::Store} and {Sendproof::OpenSearch::Store}.
    #
    # {Middleware} calls {#around} with the method, path and body of each request before the Faraday
    # adapter sends it. Reads run and are logged as +Db+ entries. In a Preview the first write raises
    # {Sendproof::PreviewWriteBlocked} and the Preview answers 409; nothing of the request is sent. Neither
    # engine can roll back, so the store always runs in +guard+ mode.
    #
    # *Coverage.* A store is +global+ by default: every client of its library, built before or after the
    # store, is guarded. Live clients are hooked in place when the store is created, and a Faraday
    # connection built later, including one rebuilt by sniffing, gets the middleware as it is built. A
    # client that uses another HTTP transport (Curb, Manticore, a custom +transport:+) can't be guarded,
    # so the store refuses to be created while one exists and fails any client built later. Pass
    # +global: false+ to guard only the clients you hook with {#hook} or build with {#install}; every
    # other client is then not covered.
    #
    # Subclasses name their system and the library classes they guard.
    class Store < Sendproof::DataStore
      # @param client [Object, nil] a client to hook in place (implies +global: false+ unless given)
      # @param name [String, nil] display label for discovery, such as +search+; never a URL or host
      # @param treat_as_read [Array<String>, nil] operations you state never write, matched exactly: the
      #   operation name a +Db+ entry shows, such as +POST /{}/_my_read+. A wrongly listed write is not blocked.
      # @param global [Boolean, nil] guard every client of the library, before and after this store
      # @raise [Sendproof::ConfigurationError] when a live client can't be guarded, or a store of this system exists
      def initialize(client: nil, name: nil, treat_as_read: nil, global: nil)
        super()
        @name = Stores::Guard.store_label(name)
        @reads = Stores::Guard.read_set(treat_as_read, spaces: true)
        @global = global.nil? ? client.nil? : global
        @active = true
        @covered = ObjectSpace::WeakMap.new
        Search.register(self)
        begin
          install_hooks
          ObjectSpace.each_object(client_class).to_a.each { |live| hook(live) if live.transport } if @global
          hook(client) if client
        rescue StandardError
          unhook!
          raise
        end
      end

      # @return [Boolean] whether every client of the library is guarded
      def global? = @global

      def describe
        { system: system, name: @name, mode: :guard }
      end

      # Turns the guard off. Connections keep their middleware, which then does nothing.
      def unhook!
        @active = false
        Search.unregister(self)
      end

      # @return [Boolean] whether the guard is still on
      def active? = @active

      # Adds the guard to a Faraday connection, as a first (outermost) middleware, once. Use it to build
      # a client of a non-global store: +Elasticsearch::Client.new(url: u) { |f| store.install(f) }+.
      #
      # @param faraday [Faraday::Connection]
      # @return [Faraday::Connection]
      def install(faraday)
        return faraday if faraday.builder.handlers.any? { |handler| handler.klass == Middleware }

        faraday.builder.insert(0, Middleware, system, faraday.url_prefix.path)
        faraday
      end

      # Called as the transport builds a connection: guards it when this store covers the transport.
      def cover(transport, faraday)
        install(faraday) if @global || @covered.key?(transport)
      end

      # Hooks a client in place: its connections are rebuilt with the middleware, and so is every
      # connection it rebuilds later. Hooking a client twice does nothing.
      #
      # @param client [Object] an +Elasticsearch::Client+ or +OpenSearch::Client+, or the transport client inside it
      # @raise [Sendproof::ConfigurationError] when it doesn't use the Faraday HTTP transport
      def hook(client)
        transport_client = transport_client_of(client)
        raise ArgumentError, "#{self.class} takes a #{wrapper_name} client." unless transport_client

        transport = verify(transport_client)
        @covered[transport] = true
        # The transport's own constructor builds its collection this way, through the prepended
        # __build_connection. Its reload helper keeps connections to hosts it already has, bare ones included.
        transport.instance_variable_set(:@connections, transport.__build_connections)
        unguarded = transport.connections.map(&:connection).reject { |faraday| faraday.builder.handlers.any? { |h| h.klass == Middleware } }
        raise ConfigurationError, "A #{display} client's connections could not be guarded." unless unguarded.empty?

        client
      end

      # Checks that a transport client uses the Faraday HTTP transport, the one the guard covers.
      # @return [Object] the HTTP transport
      def verify(transport_client)
        transport = transport_client.transport
        return transport if transport_class === transport

        raise ConfigurationError, "A #{display} client uses #{transport.class}, which Sendproof can't guard. " \
                                  "Use the default Faraday transport, or create the store with global: false and don't use that client in a Preview."
      end

      # Guards and logs one request around +block+, which sends it.
      #
      # @param method [Symbol, String] the HTTP method
      # @param path [String] the request path without the connection's prefix
      # @param body [String, Hash, nil] the request body as handed to the adapter
      # @yieldreturn [Faraday::Response]
      def around(method, path, body)
        return yield unless @active

        result = Stores::Classify.elasticsearch(method, path, body, @reads)
        return yield if result.kind == :session

        Stores::Guard.guard(system, result.operation, result.kind)
        recorder = Capture.current
        return yield unless recorder

        started = Clock.now
        entry = { system: system, operation: result.operation, target: target_of(path), statement: self.class.statement_of(body) }
        begin
          response = yield
        rescue StandardError => error
          recorder.db(**entry, error: error.class.name.to_s.split("::").last, duration_ms: Clock.elapsed_ms(started))
          raise
        end
        parsed = parse(response.body)
        error = response.status.to_i >= 400 ? error_type(parsed) || response.status.to_s : nil
        recorder.db(**entry, rows_affected: error ? nil : rows_of(parsed), error: error, duration_ms: Clock.elapsed_ms(started))
        response
      end

      # A request body as a +Db+ statement: every literal replaced by +?+, one line per NDJSON line.
      # A body that isn't JSON (compressed, for example) gives +nil+.
      def self.statement_of(body)
        case body
        when nil then nil
        when Hash, Array then lines_of([body])
        when String then lines_of(body.each_line.map(&:strip).reject(&:empty?).map { |line| JSON.parse(line) })
        end
      rescue JSON::ParserError, EncodingError, ArgumentError # ArgumentError: a String that isn't valid UTF-8
        nil
      end

      # @api private
      def self.lines_of(documents)
        documents.flat_map { |document| document.is_a?(Array) ? document : [document] }
                 .map { |document| JSON.generate(Stores::Guard.sanitize_document(document)) }.join("\n")
      end
      private_class_method :lines_of

      private

      def display = Stores::Guard.store_name(system)

      def wrapper_name = display

      # The +Elastic::Transport::Client+ (or +OpenSearch::Transport::Client+) of a client or its wrapper.
      def transport_client_of(client)
        return client if client_class === client

        inner = client.instance_variable_get(:@transport)
        inner if client_class === inner
      end

      # Prepends the hooks that cover connections and clients built later, once per library class.
      def install_hooks
        transport_class.prepend(BuildHook) unless transport_class < BuildHook
        client_class.prepend(ClientHook) if @global && !(client_class < ClientHook)
      end

      # The index a request names, for +db.collection.name+: the first path segment unless it is an endpoint.
      def target_of(path)
        first = Stores::Classify.search_segments(path).first
        first unless first.nil? || first.start_with?("_")
      end

      def parse(body)
        return nil unless body.is_a?(String) && body.bytesize <= 1_048_576 && body.lstrip.start_with?("{")

        JSON.parse(body)
      rescue JSON::ParserError, EncodingError, ArgumentError
        nil
      end

      # The engine's error type: +error.type+ of an error object. Some replies (a 405, say) carry a string.
      def error_type(parsed)
        error = parsed["error"] if parsed.is_a?(Hash)
        type = error["type"] if error.is_a?(Hash)
        type if type.is_a?(String)
      end

      # Documents returned, updated or deleted, when the reply says so.
      def rows_of(parsed)
        return nil unless parsed.is_a?(Hash)

        hits = parsed.dig("hits", "hits")
        return hits.length if hits.is_a?(Array)

        count = parsed["updated"] || parsed["deleted"]
        return count if count.is_a?(Integer)

        1 if parsed["result"]
      end
    end
  end
end
