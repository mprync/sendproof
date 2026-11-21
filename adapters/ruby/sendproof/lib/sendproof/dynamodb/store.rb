# frozen_string_literal: true

module Sendproof
  module DynamoDB
    # The DynamoDB data store: a Seahorse handler at the +initialize+ step of +Aws::DynamoDB::Client+.
    #
    # The initialize step runs before parameter validation, serialization and signing, so a refused
    # operation never becomes an HTTP request, and credentials, the +Authorization+ header and signatures
    # never reach the hook. The operation is the API action name (+UpdateItem+).
    #
    # Reads run normally. In a Preview the first write raises {Sendproof::PreviewWriteBlocked} and the
    # Preview answers 409. Every operation becomes a +Db+ log entry; PartiQL text has its literals
    # replaced by +?+ and parameter values are never captured.
    #
    # *Coverage.* Hook one client with +client:+, or every client created afterwards with +global: true+,
    # or hand {#plugin} to +Aws::DynamoDB::Client.new(plugins: [...])+. A client created some other way
    # is not covered.
    #
    # @example
    #   config.sendproof.data_store Sendproof::DynamoDB::Store.new(client: orders_client, name: "orders")
    class Store < Sendproof::DataStore
      # @param client [Aws::DynamoDB::Client, nil] a client to hook in place
      # @param name [String, nil] display label for discovery, such as +orders+; never an endpoint or ARN
      # @param treat_as_read [Array<String>, nil] action names you state never write, matched exactly
      # @param global [Boolean] add the plugin to +Aws::DynamoDB::Client+, so every client created afterwards is hooked
      def initialize(client: nil, name: nil, treat_as_read: nil, global: false)
        super()
        @name = Stores::Guard.store_label(name)
        @reads = Stores::Guard.read_set(treat_as_read)
        @active = true
        @handler = build_handler
        @plugin = build_plugin
        hook(client) if client
        ::Aws::DynamoDB::Client.add_plugin(@plugin) if global
      end

      # @return [Class] a +Seahorse::Client::Plugin+, for +Aws::DynamoDB::Client.new(plugins: [store.plugin])+
      attr_reader :plugin

      def system = "dynamodb"

      def describe
        { system: "dynamodb", name: @name, mode: :guard }
      end

      # Turns the hook off. The handler stays on the clients it was added to, but does nothing.
      def unhook! = @active = false

      # @return [Boolean] whether the hook is still guarding
      def active? = @active

      # Adds the handler to +client+ in place. Hooking a client twice is refused, so its operations are
      # never logged twice.
      def hook(client)
        unless client.respond_to?(:handlers) && client.respond_to?(:config)
          raise ArgumentError, "Sendproof::DynamoDB::Store takes an Aws::DynamoDB::Client."
        end
        raise ConfigurationError, "This DynamoDB client is already hooked." if client.handlers.entries.any? { |e| e.handler_class == @handler }

        client.handlers.add(@handler, step: :initialize, priority: 99)
        client
      end

      # Guards and logs one operation around +block+, which sends it.
      #
      # @param operation [String] the API action name, such as +UpdateItem+
      # @param params [Hash] the request parameters, snake_case symbol keys as the SDK takes them
      # @yieldreturn [Seahorse::Client::Response]
      def around(operation, params)
        return yield unless @active

        input = classification_input(params)
        Stores::Guard.guard("dynamodb", operation, Stores::Classify.dynamodb(operation, input, @reads))
        recorder = Capture.current
        return yield unless recorder

        statement = statement_of(params)
        target = target_of(params, statement)
        started = Clock.now
        begin
          response = yield
        rescue StandardError => error
          log(recorder, operation, target, statement, started, error: error)
          raise
        end
        log(recorder, operation, target, statement, started, error: response.respond_to?(:error) ? response.error : nil,
                                                              rows: rows_of(response))
        response
      end

      # Replaces every literal in PartiQL text with +?+: single-quoted strings (with +''+ escapes) and
      # numbers. Double-quoted identifiers (table and attribute names) are kept as written. A statement
      # may inline values instead of using +?+ parameters, and a value never appears in a +Db+ entry.
      def self.sanitize_partiql(text)
        output = +""
        index = 0
        while index < text.length
          char = text[index]
          if char == '"'
            close = text.index('"', index + 1)
            stop = close ? close + 1 : text.length
            output << text[index...stop]
            index = stop
          elsif char == "'"
            stop = index + 1
            stop += text[stop] == "'" ? 2 : 1 until stop >= text.length || (text[stop] == "'" && text[stop + 1] != "'")
            output << "?"
            index = stop + 1
          elsif char.match?(/[0-9]/) && !(index.positive? && text[index - 1].match?(/[\w.]/))
            number = text[index..][/\A[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/]
            output << "?"
            index += number.length
          else
            output << char
            index += 1
          end
        end
        output
      end

      private

      def build_handler
        store = self
        Class.new(Seahorse::Client::Handler) do
          define_method(:call) do |context|
            store.around(context.operation.name, context.params || {}) { @handler.call(context) }
          end
        end
      end

      def build_plugin
        handler = @handler
        Class.new(Seahorse::Client::Plugin) do
          define_method(:add_handlers) do |handlers, _config|
            handlers.add(handler, step: :initialize, priority: 99)
          end
        end
      end

      # The request in the shape the shared classifier reads: API field names, not the SDK's snake_case.
      def classification_input(params)
        input = {}
        input["Statement"] = params[:statement] if params.key?(:statement)
        input["Statements"] = params[:statements].map { |item| { "Statement" => item[:statement] } } if params[:statements]
        if params[:transact_statements]
          input["TransactStatements"] = params[:transact_statements].map { |item| { "Statement" => item[:statement] } }
        end
        input
      end

      def statement_of(params)
        return self.class.sanitize_partiql(params[:statement].to_s) if params[:statement].is_a?(String)

        list = params[:statements] || params[:transact_statements]
        list.map { |item| self.class.sanitize_partiql(item[:statement].to_s) }.join("; ") if list.is_a?(Array)
      end

      # The table a command targets: +table_name+, the first +request_items+ table, or the quoted PartiQL table.
      def target_of(params, statement)
        return params[:table_name].to_s if params[:table_name]
        return params[:request_items].keys.first.to_s if params[:request_items].respond_to?(:keys) && !params[:request_items].empty?

        statement && statement[/"([^"]+)"/, 1]
      end

      # Items matched, returned or written, when the reply says so.
      def rows_of(response)
        data = response.respond_to?(:data) ? response.data : nil
        fields = data.respond_to?(:to_h) ? data.to_h : {}
        if fields[:items].is_a?(Array) then fields[:items].length
        elsif fields[:count].is_a?(Integer) then fields[:count]
        elsif fields[:item] || fields[:attributes] then 1
        end
      end

      def log(recorder, operation, target, statement, started, error: nil, rows: nil)
        recorder.db(system: "dynamodb", operation: operation, target: target, statement: statement, rows_affected: rows,
                    error: error && error.class.name.to_s.split("::").last, duration_ms: Clock.elapsed_ms(started))
      end
    end
  end
end
