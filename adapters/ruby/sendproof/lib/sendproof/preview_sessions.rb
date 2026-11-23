# frozen_string_literal: true

module Sendproof
  # The process-local Preview session registry and its Rack endpoints.
  class PreviewSessions
    ROUTE = %r{\A/sendproof/_api/sessions(?:/([^/]+)(/rewind)?)?\z}
    HEADER = "HTTP_SENDPROOF_SESSION"

    class StoreBusy < StandardError; end
    class StoreEnded < StandardError; end
    class StepUndone < StandardError; end

    def initialize(config, idle_timeout: 300, max_lifetime: 1800)
      @config = config
      @idle_timeout = idle_timeout
      @max_lifetime = max_lifetime
      @mutex = Mutex.new
      @sessions = {}
      @stopped = false
    end

    def call(env, request, id, rewind)
      return open(env, request) if id.nil? && request.post?
      return with_session(request, id, &:end!) if id && !rewind && request.delete?
      return with_session(request, id) { |session| rewind_request(request, session) } if rewind && request.post?

      Protocol.problem(405, "This method is unavailable for preview sessions.")
    end

    def with_session(request, id, &block)
      owner = owner_of(request) if Protocol.same_origin?(request)
      session = @mutex.synchronize { @sessions[id] }
      return not_found unless owner && session&.owner == owner

      session.run(&block)
    end

    # Close on the server's shutdown hook, or as part of orderly Ruby process shutdown.
    def shutdown
      sessions = @mutex.synchronize do
        @stopped = true
        @sessions.values
      end
      sessions.each(&:stop)
      sessions.each(&:join)
    end

    def self.not_found = Protocol.problem(404, "Preview session not found.", code: "session_not_found")
    def self.failed = Protocol.problem(409, "The preview session could not hold all required stores.", code: "session_failed")
    def self.no_content = [204, { "cache-control" => "no-store" }, []]

    private

    def not_found = self.class.not_found

    def owner_of(request)
      identity = @config.identity_for(request)
      identity ? identity.owner(request.script_name) : [:anonymous, request.script_name]
    end

    def open(env, request)
      return Protocol.problem(403, "Preview sessions must be opened from the same origin.") unless Protocol.same_origin?(request)

      owner = owner_of(request)
      return Protocol.problem(403, "A preview session needs one stable subject for the signed-in caller.") unless owner

      provider = @config.preview_provider
      return Protocol.problem(409, "Preview sessions are unavailable.") unless @config.preview_sessions?(provider)

      context = ProviderContext.new(env:, request:, config: @config)
      session = @mutex.synchronize do
        return self.class.failed if @stopped
        if @sessions.size >= 16 || @sessions.values.count { |item| item.owner == owner } >= 4
          return Protocol.problem(429, "Too many preview sessions are open. End one first.", code: "session_limit")
        end

        unless @shutdown_registered
          at_exit { shutdown }
          @shutdown_registered = true
        end
        id = SecureRandom.hex(16)
        @sessions[id] = Worker.new(id, owner, context, provider, @idle_timeout, @max_lifetime) do
          @mutex.synchronize { @sessions.delete(id) }
        end
      end
      session.opened
    rescue StoreBusy => error
      Protocol.problem(409, "Another Preview session is holding #{error.message}.",
                       code: "store_busy", idleTimeoutSeconds: @idle_timeout,
                       detail: "That session ends by itself after its idle timeout (#{@idle_timeout} seconds), or when it is ended.")
    rescue StandardError => error
      @config.logger&.error("A Sendproof preview session could not open: #{error.class}: #{error.message}")
      self.class.failed
    end

    def rewind_request(request, session)
      body = request.body&.read(1025).to_s
      return invalid_step(session) if body.bytesize > 1024

      document = JSON.parse(body)
      step = document["step"] if document.is_a?(Hash)
      return invalid_step(session) unless step.is_a?(Integer) && step.between?(1, session.next_step)

      session.rewind(step)
      self.class.no_content
    rescue JSON::ParserError
      invalid_step(session)
    end

    def invalid_step(session)
      Protocol.problem(400, "Rewind to a step from 1 to #{session.next_step}, the next step this session runs.")
    end

    # A worker leases all connections and runs each step on their owning thread. Its mailbox also
    # wakes up at the next deadline, so abandoned sessions release their locks without another request.
    class Worker
      attr_reader :id, :owner, :next_step, :sql, :stores, :guards

      def initialize(id, owner, context, provider, idle_timeout, max_lifetime, &remove)
        @id, @owner = id, owner
        @config = context.config
        @idle_timeout = idle_timeout
        @max_lifetime = max_lifetime
        @next_step = 1
        @parts, @stores, @guards = [], [], []
        @mutex = Mutex.new
        @jobs, @opened = Queue.new, Queue.new
        @busy = true
        @thread = Thread.new { work(context, provider, remove) }
      end

      def opened = receive(@opened)

      def run(&block)
        result = Queue.new
        @mutex.synchronize do
          return PreviewSessions.not_found if @stopping || (@deadline && Clock.now >= @deadline) ||
                                              (!@busy && Clock.now >= @expires)
          return Protocol.problem(409, "The preview session is serving another request.", code: "session_busy") if @busy

          @busy = true
          @jobs << [@config.session_job(&block), result]
        end
        receive(result)
      end

      def advance = @next_step += 1

      def undo_step = @parts.reverse_each { |part| part.rewind(@next_step) }

      def rewind(step)
        return if step == @next_step

        @parts.reverse_each { |part| part.rewind(step) }
        @next_step = step
      end

      def end!
        @ending = true
        stop
        PreviewSessions.no_content
      end

      def stop
        @mutex.synchronize do
          return if @stopping

          @stopping = true
          @jobs.close
        end
      end

      def join = @thread.join

      private

      def work(context, provider, remove)
        result = @opened
        response = nil
        begin
          @sql = provider.begin_held_preview(context)
          raise StoreEnded unless @sql

          @parts << @sql
          @config.data_stores.each do |store|
            if store.describe[:mode].to_s == "guard"
              @guards << store
            else
              part = store.begin_held_preview(context)
              raise StoreEnded unless part

              @parts << part
              @stores << part
            end
          end
          now = Clock.now
          @deadline = now + @max_lifetime
          raise StoreEnded if release(now)
          result << Protocol.json(201, { id:, idleTimeoutSeconds: @idle_timeout, maxLifetimeSeconds: @max_lifetime },
                                  { "cache-control" => "no-store" })
          result = nil
          while (job = @jobs.pop(timeout: [@expires - Clock.now, 0].max))
            block, result = job
            response = Attribution.request { block.call(self) }
            break if release(Clock.now)

            result << response
            result = nil
          end
        rescue StoreEnded => error
          response = result == @opened ? error : PreviewSessions.failed
        rescue Exception => error # every acquisition and request unwinding must return its connections
          response = result == @opened || !error.is_a?(StandardError) ? error : fail_request(error)
        ensure
          stop
          failure = close_parts
          remove.call
          response = fail_request(failure) if failure && @ending
          result << response if result
          @jobs.pop&.last&.push(PreviewSessions.not_found)
        end
      end

      def release(now)
        @mutex.synchronize do
          store_deadlines = @stores.filter_map { |store| store.expires_at if store.respond_to?(:expires_at) }
          @expires = [now + @idle_timeout, @deadline, *store_deadlines].min
          @busy = false
          @stopping || now >= @deadline
        end
      end

      def close_parts
        failure = nil
        @parts.reverse_each do |part|
          part.close
        rescue Exception => error # even a failed store close must release the other held stores
          @config.logger&.error("A held Preview transaction could not be rolled back: #{error.class}: #{error.message}")
          failure ||= error
        end
        failure
      end

      def fail_request(error)
        @config.logger&.error("A Sendproof preview session could not continue: #{error.class}: #{error.message}")
        Protocol.problem(500, "The preview session could not continue safely and was closed.")
      end

      def receive(queue)
        value = @config.wait_for_session { queue.pop }
        raise value if value.is_a?(Exception)

        value
      end
    end
  end
end
