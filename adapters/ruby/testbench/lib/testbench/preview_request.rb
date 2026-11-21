# frozen_string_literal: true

module TestBench
  # State of one rollback preview, stored in the Rack environment under {ENV_KEY}.
  class PreviewRequest
    attr_reader :clock, :recorder
    # @return [#rollback!, nil] the provider session opened before the handler ran
    attr_accessor :session

    def initialize(recorder:, clock:)
      @recorder = recorder
      @clock = clock
      @invoked = false
      @completed = false
      @rejected = false
    end

    # @return [Boolean] whether the endpoint handler started
    def invoked? = @invoked
    # @return [Boolean] whether the endpoint handler returned normally
    def completed? = @completed
    # @return [Boolean] whether the handler was refused because the endpoint is not preview-enabled
    def rejected? = @rejected

    # Marks the handler complete when the framework turned its exception into a handled client-error response.
    def complete!
      @completed = true
    end

    # Wraps the endpoint handler. See {Handler.around}.
    def around_handler(request:, eligible:)
      if !eligible || @invoked
        @rejected = true
        raise IneligibleHandler, "The endpoint is not enabled for Test Bench preview."
      end

      @invoked = true
      @clock.start_handler
      result = yield
      @completed = true
      result
    end
  end
end
