# frozen_string_literal: true

module Sendproof
  # Holds the {Recorder} for the request running on the current thread (or fiber).
  #
  # Work started on other threads is not attributed to the request.
  module Capture
    KEY = :sendproof_recorder

    module_function

    # @return [Recorder, nil]
    def current
      Thread.current[KEY]
    end

    # Makes +recorder+ current for the block, restoring the previous one afterwards.
    def with(recorder)
      previous = Thread.current[KEY]
      Thread.current[KEY] = recorder
      yield
    ensure
      Thread.current[KEY] = previous
    end
  end
end
