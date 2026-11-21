# frozen_string_literal: true

require "json"
require "set"
require "uri"

module Sendproof
  module Stores
    # Write classification for the batch-one data stores, driven by the shared tables in
    # spec/data-stores/ (embedded in {Tables}). Each table lists reads and connection-level commands;
    # everything else, including a command the table has never heard of, is a write, so the guard
    # fails closed when a store adds a command.
    #
    # Every method is pure. The shared vectors in spec/data-stores/classification-cases.json run
    # through them in test/stores/classify_test.rb.
    module Classify
      # The result of classifying a MongoDB command document.
      # @!attribute kind [Symbol] +:read+, +:write+ or +:session+
      # @!attribute refused_in_transaction [String, nil] the command or aggregation stage MongoDB
      #   refuses inside a transaction, such as +$out+
      MongoResult = Struct.new(:kind, :refused_in_transaction)

      REDIS = {
        read: (Tables::REDIS["read"] + Tables::REDIS["moduleRead"]).to_set,
        session: Tables::REDIS["session"].to_set,
        transaction: Tables::REDIS["transaction"].to_set
      }.freeze
      MONGO = {
        read: Tables::MONGODB["read"].to_set(&:downcase),
        session: Tables::MONGODB["session"].to_set(&:downcase),
        not_in_transaction: Tables::MONGODB["notInTransaction"]["commands"].to_set(&:downcase),
        stages: Tables::MONGODB["notInTransaction"]["stages"].freeze
      }.freeze
      DYNAMO = {
        read: Tables::DYNAMODB["read"].to_set,
        partiql: Tables::DYNAMODB["partiql"]["operations"].to_set
      }.freeze
      WRITING_STAGES = %w[$out $merge].to_set.freeze

      # The result of classifying an Elasticsearch, OpenSearch or Firestore request.
      # @!attribute kind [Symbol] +:read+, +:write+ or +:session+
      # @!attribute operation [String] the +db.operation.name+: the table's endpoint id or RPC name
      Result = Struct.new(:kind, :operation)

      # One endpoint of elasticsearch.json with its paths split into segments for matching.
      SearchEndpoint = Struct.new(:kind, :name, :methods, :paths)

      SEARCH = {
        endpoints: Tables::ELASTICSEARCH["endpoints"].map do |entry|
          SearchEndpoint.new(entry["kind"].to_sym, entry["name"], entry["methods"].to_set.freeze,
                             entry["paths"].map { |path| path.split("/").reject(&:empty?).freeze }.freeze).freeze
        end.freeze,
        method_default: Tables::ELASTICSEARCH["methodDefault"].freeze,
        sql_words: Tables::ELASTICSEARCH["sql"]["readWords"].to_set.freeze
      }.freeze
      FIRESTORE = {
        services: Tables::FIRESTORE["services"].freeze,
        verbs: Tables::FIRESTORE["fromRest"]["verbs"].freeze
      }.freeze

      module_function

      # Classifies a Redis command.
      #
      # @param name [String, Symbol] the command name in any case
      # @param args [Array] its arguments; only the first is read, to form +CONTAINER|SUBCOMMAND+ keys
      #   such as +OBJECT|ENCODING+
      # @param treat_as_read [Set<String>, nil] host-declared reads, compared exactly with the
      #   upper-case key
      # @return [Symbol] +:read+, +:write+, +:session+ or +:transaction+
      def redis(name, args = [], treat_as_read = nil)
        command = name.to_s.upcase
        first = args.first
        with_sub = first.nil? ? command : "#{command}|#{first.to_s.upcase}"
        [with_sub, command].each do |key|
          return :session if REDIS[:session].include?(key)
          return :transaction if REDIS[:transaction].include?(key)
          return :read if REDIS[:read].include?(key) || treat_as_read&.include?(key)
        end
        :write
      end

      # Classifies a MongoDB command document by its first key, case-insensitively. +aggregate+ is a
      # write when any stage at any depth is +$out+ or +$merge+; +explain+ takes the classification
      # of the command inside it.
      #
      # @param command [Hash] the command document, string or symbol keys
      # @param treat_as_read [Set<String>, nil] host-declared reads in lower case
      # @return [MongoResult] the kind, and what a +preview+-mode Preview must block before sending
      def mongo(command, treat_as_read = nil)
        command = command.to_h
        name = command.keys.first.to_s
        lower = name.downcase
        inner = command[command.keys.first]
        return mongo(inner, treat_as_read) if lower == "explain" && inner.is_a?(Hash)

        refused = name if MONGO[:not_in_transaction].include?(lower)
        pipeline = fetch(command, "pipeline")
        refused = MONGO[:stages].find { |stage| pipeline_uses?(pipeline, [stage]) } || refused if lower == "aggregate"
        return MongoResult.new(:session, nil) if MONGO[:session].include?(lower)
        return MongoResult.new(:write, refused) if lower == "aggregate" && pipeline_uses?(pipeline, WRITING_STAGES)
        return MongoResult.new(:read, refused) if MONGO[:read].include?(lower) || treat_as_read&.include?(lower)

        MongoResult.new(:write, refused)
      end

      # Skips whitespace and SQL-style comments, then returns the first word of a PartiQL statement
      # in upper case. An unterminated block comment gives an empty string.
      def partiql_verb(statement)
        text = statement.to_s
        loop do
          trimmed = text.sub(/\A\s+/, "")
          if trimmed.start_with?("--")
            newline = trimmed.index("\n")
            text = newline ? trimmed[(newline + 1)..] : ""
          elsif trimmed.start_with?("/*")
            close = trimmed.index("*/")
            return "" unless close

            text = trimmed[(close + 2)..]
          else
            return trimmed[/\A[A-Za-z]+/].to_s.upcase
          end
        end
      end

      # Classifies a DynamoDB action and its input as +:read+ or +:write+. A PartiQL request is a read
      # only when every statement in it is a +SELECT+.
      #
      # @param operation [String] the API action name, such as +UpdateItem+
      # @param input [Hash] the request parameters
      # @param treat_as_read [Set<String>, nil] host-declared action names
      def dynamodb(operation, input = {}, treat_as_read = nil)
        operation = operation.to_s
        return :read if DYNAMO[:read].include?(operation) || treat_as_read&.include?(operation)
        return :write unless DYNAMO[:partiql].include?(operation)

        statements = if operation == "ExecuteStatement"
                       [fetch(input, "Statement")]
                     else
                       list = fetch(input, "Statements") || fetch(input, "TransactStatements")
                       list.is_a?(Array) ? list.map { |item| fetch(item, "Statement") } : []
                     end
        statements.any? && statements.all? { |statement| partiql_verb(statement) == "SELECT" } ? :read : :write
      end

      # Splits a request path into decoded segments: no query string, no repeated or trailing slashes.
      # A segment that isn't valid percent-encoding is kept as written.
      def search_segments(path)
        path.to_s.split("?", 2).first.to_s.split("/").reject(&:empty?).map do |segment|
          URI.decode_uri_component(segment)
        rescue ArgumentError
          segment
        end
      end

      # Classifies an Elasticsearch or OpenSearch request by HTTP method and path, the unit
      # elasticsearch.json defines, and for the SQL endpoints by the body too. The caller removes any
      # path prefix the client is configured with. +GET+ and +HEAD+ read on every path; anything else
      # the table doesn't list is a write.
      #
      # @param method [String, Symbol] the HTTP method in any case
      # @param path [String] the request path, with or without a query string
      # @param body [String, Hash, nil] the request body, read only for the SQL endpoints
      # @param treat_as_read [Set<String>, nil] host-declared reads, compared exactly with the operation name
      # @return [Result] +:read+, +:write+ or +:session+, with the endpoint id as the operation
      def elasticsearch(method, path, body = nil, treat_as_read = nil)
        verb = method.to_s.upcase
        segments = search_segments(path)
        SEARCH[:endpoints].each do |entry|
          next unless entry.methods.include?(verb)
          next unless entry.paths.any? { |pattern| search_path_matches?(pattern, segments) }

          kind = entry.kind == :sql ? (search_sql_reads?(body) ? :read : :write) : entry.kind
          return Result.new(kind, entry.name)
        end
        operation = "#{verb} /#{segments.map { |segment| segment.start_with?('_') ? segment : '{}' }.join('/')}"
        default = SEARCH[:method_default][verb] || Tables::ELASTICSEARCH["default"]
        default = "read" if treat_as_read&.include?(operation)
        Result.new(default.to_sym, operation)
      end

      # Whether a request path's segments match an endpoint pattern: +{index}+ is any segment that
      # doesn't start with an underscore, +{id}+ any non-empty segment, anything else must be equal.
      def search_path_matches?(pattern, segments)
        return false unless pattern.length == segments.length

        pattern.each_with_index.all? do |part, index|
          segment = segments[index]
          case part
          when "{index}" then !segment.empty? && !segment.start_with?("_")
          when "{id}" then !segment.empty?
          else part == segment
          end
        end
      end

      # Whether an SQL request is a read: one statement starting with SELECT, SHOW, DESCRIBE or DESC with
      # nothing after it but whitespace, comments and one semicolon, or a cursor page with no query.
      def search_sql_reads?(body)
        parsed = body
        if body.is_a?(String)
          begin
            parsed = JSON.parse(body)
          rescue JSON::ParserError
            return false
          end
        end
        return false unless parsed.is_a?(Hash)

        query = fetch(parsed, "query")
        if query.is_a?(String)
          shape = statement_shape(query, backticks: true)
          return !shape[:broken] && !shape[:multiple] && SEARCH[:sql_words].include?(shape[:first])
        end
        query.nil? && fetch(parsed, "cursor").is_a?(String)
      end

      # Reads the shape of one SQL-like statement: its first word in upper case, and whether anything but
      # whitespace, comments and one semicolon follows it outside quotes. +broken+ is true for an
      # unterminated comment or quote. Quotes are +'+, +"+ and, with +backticks+, a backtick.
      #
      # @return [Hash] +:first+, +:multiple+ and +:broken+
      def statement_shape(text, backticks: false)
        source = text.to_s
        index = 0
        skip = lambda do
          loop do
            index += 1 while index < source.length && source[index].match?(/\s/)
            if source[index, 2] == "--"
              newline = source.index("\n", index)
              index = newline ? newline + 1 : source.length
            elsif source[index, 2] == "/*"
              close = source.index("*/", index + 2)
              raise ArgumentError, "unterminated comment" unless close

              index = close + 2
            else
              break
            end
          end
        end
        skip.call
        first = source[index..][/\A[A-Za-z_]+/].to_s
        index += first.length
        multiple = false
        while index < source.length
          if source[index, 2] == "--" || source[index, 2] == "/*"
            skip.call
            next
          end
          char = source[index]
          if char == "'" || char == '"' || (backticks && char == "`")
            close = index + 1
            loop do
              close = source.index(char, close) or raise ArgumentError, "unterminated quote"
              if source[close + 1] == char
                close += 2
                next
              end
              break
            end
            index = close + 1
            next
          end
          index += 1
          next unless char == ";"

          skip.call
          multiple = index < source.length
          break
        end
        { first: first.upcase, multiple: multiple, broken: false }
      rescue ArgumentError
        { first: "", multiple: false, broken: true }
      end

      # Classifies a Firestore gRPC call by RPC name, and for +Commit+ by whether it carries writes.
      #
      # @param rpc [String] the gRPC path (+/google.firestore.v1.Firestore/Commit+) or a bare v1 method name
      # @param message [Hash, #writes, nil] the request message, when the hook can read it; a +Commit+
      #   whose message can't be read is a write
      # @param treat_as_read [Set<String>, nil] host-declared reads, compared exactly with the RPC name
      # @return [Result] +:read+, +:session+ or +:write+, with the RPC name as the operation
      def firestore(rpc, message = nil, treat_as_read = nil)
        service, name = rpc.to_s.include?("/") ? rpc.to_s.split("/").reject(&:empty?) : ["google.firestore.v1.Firestore", rpc.to_s]
        operation = name.to_s
        known = FIRESTORE[:services][service]
        return Result.new(:read, operation) if treat_as_read&.include?(operation)
        return Result.new(:write, operation) unless known
        return Result.new(known["readPrefixes"].any? { |prefix| operation.start_with?(prefix) } ? :read : :write, operation) if known["readPrefixes"]
        return Result.new(firestore_commit(message), operation) if operation == "Commit"
        return Result.new(:read, operation) if known["read"].include?(operation)
        return Result.new(:session, operation) if known["session"].include?(operation)

        Result.new(:write, operation)
      end

      # A +Commit+ is +:session+ only when its message is readable and its +writes+ list is empty.
      def firestore_commit(message)
        return :write if message.nil?

        writes = message.respond_to?(:writes) ? message.writes : fetch(message, "writes")
        return :session if writes.nil? && message.is_a?(Hash)
        return :write unless writes.respond_to?(:size)

        writes.size.zero? ? :session : :write
      end

      # Derives the Firestore RPC name from a REST request, as firestore.json's +fromRest+ describes.
      # The binding hooks gRPC only; this keeps the shared REST vectors honest for a future REST hook.
      def firestore_rest(method, path)
        segments = search_segments(path)
        last = segments.last.to_s
        colon = last.rindex(":")
        return FIRESTORE[:verbs].fetch(last[(colon + 1)..], last[(colon + 1)..]) if colon

        after = segments.length - ((segments.index("documents") || -1) + 1)
        document = segments.include?("documents") && after.positive? && after.even?
        case method.to_s.upcase
        when "GET" then document ? "GetDocument" : "ListDocuments"
        when "PATCH" then "UpdateDocument"
        when "DELETE" then "DeleteDocument"
        when "POST" then document ? "POST" : "CreateDocument"
        else method.to_s.upcase
        end
      end

      # Whether any key of an aggregation pipeline, at any depth (sub-pipelines included), is one of +stages+.
      def pipeline_uses?(value, stages)
        case value
        when Array then value.any? { |item| pipeline_uses?(item, stages) }
        when Hash then value.any? { |key, inner| stages.include?(key.to_s) || pipeline_uses?(inner, stages) }
        else false
        end
      end

      # Reads +key+ from a hash with string or symbol keys.
      def fetch(hash, key)
        return nil unless hash.respond_to?(:key?)

        hash.key?(key) ? hash[key] : hash[key.to_sym]
      end
    end
  end
end
