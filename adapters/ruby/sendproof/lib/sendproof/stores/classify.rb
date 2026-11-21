# frozen_string_literal: true

require "set"

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
