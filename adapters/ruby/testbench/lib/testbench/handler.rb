# frozen_string_literal: true

module TestBench
  # The hook a framework adapter (or a Rack-only application) wraps around the real endpoint handler.
  #
  # Authorization and routing run before the block, so a rejected request never reaches it.
  # The block is the point where preview rollback and observed-send capture are anchored.
  module Handler
    module_function

    # Runs the block as the endpoint handler.
    #
    # @param env [Hash] Rack environment of the request being handled
    # @param eligible [Boolean] whether the endpoint is preview-enabled
    # @raise [IneligibleHandler] during a preview when +eligible+ is false (the block does not run)
    def around(env, request: nil, eligible: true, &block)
      context = env[ENV_KEY]
      return yield unless context

      context.around_handler(request: request || Rack::Request.new(env), eligible:, &block)
    end
  end
end
