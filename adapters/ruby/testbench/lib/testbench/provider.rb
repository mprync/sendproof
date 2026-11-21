# frozen_string_literal: true

module TestBench
  # Describes what a provider receives when a preview or observation begins.
  # @!attribute env [Hash] the Rack environment of the original request
  # @!attribute request [Rack::Request]
  # @!attribute config [Configuration]
  ProviderContext = Data.define(:env, :request, :config)

  # Base class and contract for a persistence provider.
  #
  # A provider opens a rollback-only session on the connection the request handler will use,
  # captures change snapshots, rolls back explicitly, and releases every resource on every
  # failure path. Subclassing is optional; any object with these methods works.
  class Provider
    # @return [Boolean] whether this request can be previewed
    def available?
      true
    end

    # @return [String, nil] a display label for the database; never connection details
    def database
      nil
    end

    # Starts the transaction before the handler runs.
    # @param context [ProviderContext]
    # @return [PreviewSession]
    def begin_preview(context)
      raise NotImplementedError, "#{self.class} must implement begin_preview"
    end

    # Optionally observes changes of an ordinary send without managing its transaction.
    # @return [Observation, nil]
    def begin_observation(_context)
      nil
    end

    # The rollback-only session for one preview request.
    #
    # Duck-typed interface: +changes+ (array of hashes with +:operation+, +:table+, +:key+, +:before+, +:after+),
    # +changes_truncated?+, +rollback!+ (raise on failure), +close+ (idempotent) and optionally
    # +finalize_capture(recorder)+, called after rollback while the recorder is still active.
    class PreviewSession
      def changes = []
      def changes_truncated? = false

      def rollback!
        raise NotImplementedError
      end

      def close; end
    end

    # Observes an ordinary send. Interface: +changes+, +changes_truncated?+, +close+, and optionally
    # +finalize_capture(recorder)+ called before the trace is built.
    class Observation
      def changes = []
      def changes_truncated? = false
      def close; end
    end
  end
end
