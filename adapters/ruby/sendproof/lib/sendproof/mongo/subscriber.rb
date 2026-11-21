# frozen_string_literal: true

module Sendproof
  module Mongo
    # The command-monitoring subscriber the {Engine} registers on its client. The Ruby driver calls
    # +started+ on the calling thread before it writes the command to the socket, and an exception raised
    # from it propagates out of the driver call, so the engine can refuse a command before any byte of it
    # is sent. That is behavior of the driver, not a documented hook: the Preview tests prove it with an
    # independent read, and the engine falls back to refusing the Preview's confirmation if a later driver
    # stops propagating it.
    class Subscriber
      def initialize(engine)
        @engine = engine
      end

      def started(event) = @engine.command_started(event)
      def succeeded(event) = @engine.command_succeeded(event)
      def failed(event) = @engine.command_failed(event)
    end
  end
end
