# frozen_string_literal: true

module Sendproof
  # Matches a request to an OpenAPI-style operation such as +POST /items/{id}+.
  class OperationMatcher
    Operation = Struct.new(:method, :path, :pattern)

    def initialize(operations)
      @operations = operations.map do |method, path|
        Operation.new(method.to_s.upcase, path, self.class.pattern(path))
      end
    end

    # @return [Operation, nil]
    def resolve(method, path)
      method = method.to_s.upcase
      @operations.find { |operation| operation.method == method && operation.pattern.match?(path) }
    end

    # Converts +/items/{id}+ into an anchored, case-insensitive pattern.
    def self.pattern(template)
      parts = template.split(/(\{[^}\/]+\})/).map do |part|
        part.start_with?("{") ? "[^/]+" : Regexp.escape(part)
      end
      Regexp.new("\\A#{parts.join}/?\\z", Regexp::IGNORECASE)
    end
  end
end
