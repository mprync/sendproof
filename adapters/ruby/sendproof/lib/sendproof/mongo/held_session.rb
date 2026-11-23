# frozen_string_literal: true

module Sendproof
  module Mongo
    # MongoDB has no savepoints. The latest images give a step its starting view,
    # and the per-step before images let rewind restore that view inside the transaction.
    class HeldSession
      def initialize(engine, state, timeout, validate_client)
        @engine, @state = engine, state
        @timeout = timeout
        @validate_client = validate_client
        @images, @steps = {}, {}
      end

      def begin_step(step, recorder)
        check_deadline
        @validate_client&.call
        @step = step
        @steps[@step] = {}
        @engine.attach_held(@state, recorder)
      end

      def capture_step(recorder)
        check_deadline
        @engine.capture_held(@state, recorder)
      end

      def known?(key) = @images.key?(key)
      def known_image(key) = @images[key].last

      def known_candidates(filter)
        @images.values.filter_map do |candidate, image|
          candidate if image && candidate.namespace == filter.namespace && candidate.collection == filter.collection
        end
      end

      def record(key, candidate, before, after)
        @steps[@step][key] = [candidate, before]
        @images[key] = [candidate, after]
      end

      def rewind(step)
        check_deadline
        @steps.keys.select { |number| number >= step }.sort.reverse_each do |number|
          images = @steps.delete(number)
          @engine.restore_held(@state, images.values)
          @images.merge!(images)
        end
      end

      def server_ended! = @ended = true

      def close = @engine.close_held(@state)

      def expires_at
        @deadline ||= Clock.now + @timeout if @state.opened
      end

      private

      def check_deadline
        deadline = expires_at
        raise PreviewSessions::StoreEnded if @ended || (deadline && Clock.now >= deadline)
      end
    end
  end
end
