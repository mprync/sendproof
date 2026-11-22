# frozen_string_literal: true

require "set"

module Sendproof
  # Raised to the handler when the write guard refuses a command during a Preview. No byte of the
  # command reached the store. The Preview answers 409 even when the handler rescues this error and
  # returns 200: the mark on the request's recorder, not the handler's response, decides.
  class PreviewWriteBlocked < StandardError
    # @return [String] the store id, such as +"redis"+
    attr_reader :store
    # @return [String] the refused command or action name
    attr_reader :operation

    def initialize(store, operation, detail)
      super(detail)
      @store = store
      @operation = operation
    end
  end

  # Raised when a handler tries to end or escape the Preview transaction: a raw SQL +COMMIT+, a
  # MongoDB +commitTransaction+, or a store command sent with a session other than the Preview's.
  # The Preview answers 500 without confirmation even if the handler rescues it.
  class PreviewTransactionControl < StandardError; end

  module Stores
    # The write guard of spec/data-stores.md: the single decision point every store hook calls before
    # it sends a command, plus the helpers hooks share for logging and redaction.
    #
    # Outside a Preview the guard does nothing, so Send and observed Send are never blocked.
    module Guard
      # Display names used in "Preview unavailable: this operation writes to <Store>".
      NAMES = { "mongodb" => "MongoDB", "redis" => "Redis", "dynamodb" => "DynamoDB", "elasticsearch" => "Elasticsearch",
                "opensearch" => "OpenSearch", "firestore" => "Firestore" }.freeze

      module_function

      # @return [String] the display name of a store id; an unknown id is shown as given
      def store_name(store) = NAMES.fetch(store.to_s, store.to_s)

      # @return [String] the reason shown for a write to a guarded store
      def write_reason(store) = "Preview unavailable: this operation writes to #{store_name(store)}"

      # Call before sending a store command. Does nothing for anything but a write. In a Preview it marks
      # the recorder blocked (the first block wins), logs a blocked +Db+ entry and raises
      # {PreviewWriteBlocked}. Outside a Preview it lets the write through, unless it belongs to no request
      # while a Preview is open: {Attribution} then refuses it the same way and blocks every open Preview.
      #
      # @param kind [Symbol] from {Classify}; only +:write+ blocks
      # @param detail [String, nil] replaces the default "writes to <Store>" reason, for example for a
      #   MongoDB command that can't run inside a transaction
      def guard(store, operation, kind, detail = nil)
        return unless kind == :write

        recorder = Capture.preview
        unless recorder
          Attribution.refuse_unattributed(store, operation)
          return
        end
        reason = detail || write_reason(store)
        recorder.block(store: store, operation: operation, detail: reason)
        recorder.db(system: store, operation: operation, blocked: true)
        raise PreviewWriteBlocked.new(store, operation, reason)
      end

      # Refuses something that would end or escape the Preview transaction. Records the fault on the
      # current Preview, so the Preview fails with 500 even if the handler rescues the error, and
      # returns the error for the caller to raise. Outside a Preview it returns +nil+.
      #
      # @return [PreviewTransactionControl, nil]
      def refuse_in_preview(message)
        recorder = Capture.preview or return nil
        error = PreviewTransactionControl.new(message)
        recorder.refuse(error)
        error
      end

      # Replaces every literal in a command document with +"?"+, keeping field names and operators,
      # for the +statement+ of a MongoDB +Db+ entry (OpenTelemetry +db.query.text+). BSON values,
      # times and binary strings are literals too.
      def sanitize_document(value)
        case value
        when Array then value.map { |item| sanitize_document(item) }
        when Hash then value.to_h { |name, inner| [name.to_s, sanitize_document(inner)] }
        else "?"
        end
      end

      # Validates the optional label a host gives a store for capabilities +dataStores+. Discovery is
      # shown to anyone who can open the workbench, so the label must be a display name such as
      # +catalog+: never a connection string, URL, host:port, user or password.
      #
      # @return [String, nil]
      # @raise [ArgumentError] when the label looks like a connection detail
      def store_label(name)
        return nil if name.nil?

        text = name.to_s
        if !name.is_a?(String) || text.strip.empty? || text.length > 64 || text.match?(%r{[[:cntrl:]/\\@=;:?#%]})
          raise ArgumentError, 'A data store name must be a display label such as "catalog", not a connection string, URL or host.'
        end

        text
      end

      # Normalizes host-declared reads ("TreatAsRead") into an exact-match set, after +transform+.
      #
      # @param names [Array<String>, nil]
      # @param spaces [Boolean] allow a space inside a name, for an Elasticsearch operation such as
      #   +POST /{}/_my_read+; a wildcard is never allowed
      # @return [Set<String>, nil]
      # @raise [ArgumentError] for a wildcard or blank name
      def read_set(names, spaces: false, &transform)
        return nil if names.nil?

        forbidden = spaces ? /[*?\t\r\n]/ : /[*?\s]/
        unless names.is_a?(Array) && names.all? { |name| name.is_a?(String) && !name.strip.empty? && !name.match?(forbidden) }
          raise ArgumentError, "treat_as_read takes exact command names, without wildcards."
        end

        transform ||= :itself.to_proc
        names.to_set(&transform)
      end
    end
  end
end
