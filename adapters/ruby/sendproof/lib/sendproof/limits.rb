# frozen_string_literal: true

module Sendproof
  # Capture limits shared by every adapter. They match the .NET adapter so UIs behave identically.
  module Limits
    LOGS = 500
    EFFECTS = 100
    CHANGES = 200
    PROPERTIES = 32
    PARAMETERS = 64
    NAME = 256
    TEXT = 4096
    PAYLOAD_BYTES = 16 * 1024
    LOG_BUDGET = 128 * 1024
    PAYLOAD_BUDGET = 128 * 1024
    MAX_DEPTH = 16
    RESPONSE_BYTES = 1024 * 1024

    module_function

    # Truncates to at most +maximum+ characters.
    def clip(value, maximum = TEXT)
      value = value.to_s
      value.length <= maximum ? value : value[0, maximum]
    end

    # Serializes +value+ to plain JSON data within the payload limits.
    # @return [Object, nil] parsed JSON value, or nil when it is cyclic, too big or fails to serialize
    def snapshot(value)
      return nil if value.nil?
      # Reject oversized plain data before serializing it, so a huge host payload is never copied.
      return nil unless bounded?(value)

      json = JSON.generate(value, max_nesting: MAX_DEPTH)
      return nil if json.bytesize > PAYLOAD_BYTES

      parsed = JSON.parse(json, max_nesting: MAX_DEPTH)
      fits?(parsed) ? parsed : nil
    rescue StandardError, SystemStackError
      # Host payloads can be cyclic or raise from a getter. Capture must never interrupt the application.
      nil
    end

    def size(value)
      value.nil? ? 0 : JSON.generate(value).length
    end

    # Applies the change count, payload budget and per-value limits.
    # @param changes [Array<Hash>] with :operation, :table, :key, :before, :after
    # @return [Array(Array<Hash>, Boolean)] snapshots and a truncated flag
    def snapshot_changes(changes)
      result = []
      truncated = changes.length > CHANGES
      remaining = PAYLOAD_BUDGET
      changes.first(CHANGES).each do |change|
        key = change[:key].nil? ? nil : snapshot(change[:key])
        before = change[:before].nil? ? nil : snapshot(change[:before])
        after = change[:after].nil? ? nil : snapshot(change[:after])
        operation = clip(change[:operation], NAME)
        table = clip(change[:table], NAME)
        remaining -= size(key) + size(before) + size(after) + operation.length + table.length
        if remaining.negative?
          truncated = true
          break
        end

        truncated ||= (key.nil? && !change[:key].nil?) || (before.nil? && !change[:before].nil?) ||
                      (after.nil? && !change[:after].nil?) || operation != change[:operation].to_s ||
                      table != change[:table].to_s
        result << { operation:, table:, key:, before:, after: }
      end
      [result, truncated]
    end

    # Walks plain Ruby data (strings, symbols, arrays, hashes) and stops at the first value that
    # {fits?} would reject, or once the strings alone exceed {PAYLOAD_BYTES}. Other objects are
    # left to the serializer. +budget+ is a one-element array so the remaining bytes are shared.
    def bounded?(value, depth = 0, budget = [PAYLOAD_BYTES])
      return false if depth >= MAX_DEPTH

      case value
      when String
        value.length <= TEXT && (budget[0] -= value.bytesize) >= 0
      when Symbol then bounded?(value.to_s, depth, budget)
      when Array
        value.length <= PARAMETERS && value.all? { |item| bounded?(item, depth + 1, budget) }
      when Hash
        value.length <= PARAMETERS && value.all? do |name, item|
          key = name.to_s
          key.length <= NAME && (budget[0] -= key.bytesize) >= 0 && bounded?(item, depth + 1, budget)
        end
      else true
      end
    end

    def fits?(value, depth = 0)
      return false if depth >= MAX_DEPTH

      case value
      when String then value.length <= TEXT
      when Array then value.length <= PARAMETERS && value.all? { |item| fits?(item, depth + 1) }
      when Hash
        value.length <= PARAMETERS && value.all? { |name, item| name.length <= NAME && fits?(item, depth + 1) }
      else true
      end
    end
  end
end
