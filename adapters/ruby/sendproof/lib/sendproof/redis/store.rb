# frozen_string_literal: true

module Sendproof
  module Redis
    # The Redis data store: a +redis-client+ middleware that classifies every command, pipeline and
    # +MULTI+ before any byte of it is written, refuses writes during a Preview, and logs each command as
    # a +Db+ entry.
    #
    # Reads run normally. In a Preview the first write raises {Sendproof::PreviewWriteBlocked} and the
    # Preview answers 409. Session commands (+AUTH+, +HELLO+, +SELECT+, +PING+ ...) are never guarded or
    # logged, so the password never reaches a capture.
    #
    # *Coverage.* +RedisClient.register+ is process-wide, so by default every +redis-client+ (and +redis+
    # 5) client in the process is guarded, including ones created later. Pass +global: false+ and add
    # {#middleware} to a single client's +middlewares:+ to cover only that client. A +pubsub+ connection
    # writes straight to its socket, past the middleware, so its +call+ and +call_v+ are guarded too, for
    # the clients the store covers. Not covered: clients of other libraries and raw sockets. Sidekiq
    # enqueues are writes, so a Preview that enqueues a job is blocked: record the job as an effect
    # with +Sendproof.record_job+ instead.
    #
    # @example
    #   config.sendproof.data_store Sendproof::Redis::Store.new(name: "cache")
    class Store < Sendproof::DataStore
      # @param name [String, nil] display label for discovery, such as +cache+; never a URL or host
      # @param treat_as_read [Array<String>, nil] commands you state never write, such as a module read
      #   +MYMODULE.GET+: exact upper-case names (or +CONTAINER|SUB+), no wildcards. A wrongly listed
      #   write is not blocked.
      # @param global [Boolean] register the middleware for every client in the process (default)
      def initialize(name: nil, treat_as_read: nil, global: true)
        super()
        @name = Stores::Guard.store_label(name)
        @reads = Stores::Guard.read_set(treat_as_read) { |command| command.to_s.upcase }
        @active = true
        @middleware = build_middleware
        PubSubGuard.install!
        self.class.stores << self
        return unless global

        # A second hook would log every command twice and guard it twice.
        raise ConfigurationError, "A Sendproof::Redis::Store is already registered; call unhook! on it first." if self.class.registered

        ::RedisClient.register(@middleware)
        self.class.registered = self
      end

      class << self
        # @return [Store, nil] the store whose middleware is registered process-wide
        attr_accessor :registered

        # @return [Array<Store>] every store still guarding, global or per client
        def stores = @stores ||= []

        # Guards one command a +pubsub+ connection is about to write, with the store covering the client
        # the connection came from (+middlewares+ is that client's middleware stack).
        def guard_pubsub(middlewares, command, &)
          store = middlewares && stores.find { |candidate| candidate.active? && middlewares.is_a?(candidate.middleware) }
          store ? store.around([command], &) : yield
        end
      end

      # Guards the commands of +pubsub+ connections, which redis-client writes to the socket directly.
      module PubSubGuard
        # Remembers which client's middleware stack a +pubsub+ connection came from.
        module Client
          def pubsub
            middlewares = @middlewares
            super.tap { |connection| connection.instance_variable_set(:@sendproof_middlewares, middlewares) }
          end
        end

        # Classifies each command before it is written.
        module Connection
          def call(*command, **kwargs)
            Store.guard_pubsub(@sendproof_middlewares, @command_builder.generate(command, kwargs)) { super }
          end

          def call_v(command)
            Store.guard_pubsub(@sendproof_middlewares, @command_builder.generate(command)) { super }
          end
        end

        # Prepends both modules once.
        def self.install!
          return if @installed

          @installed = true
          ::RedisClient.prepend(Client)
          ::RedisClient::PubSub.prepend(Connection)
        end
      end

      # @return [Module] the +redis-client+ middleware, for +RedisClient.config(middlewares: [...])+
      attr_reader :middleware

      def system = "redis"

      def describe
        { system: "redis", name: @name, mode: :guard }
      end

      # Turns the hook off. The middleware stays registered in +redis-client+ (a module can't be
      # removed from a class) but does nothing, and another store may then register.
      def unhook!
        @active = false
        self.class.stores.delete(self)
        self.class.registered = nil if self.class.registered.equal?(self)
      end

      # @return [Boolean] whether the hook is still guarding
      def active? = @active

      # Classifies +commands+ (arrays of strings), guards them, runs the block and logs each command.
      # The middleware calls this; it is public so a batch can be checked without a server.
      #
      # @param commands [Array<Array<String>>]
      # @return the block's result
      def around(commands)
        return yield unless @active

        entries = commands.map { |command| [command.first.to_s.upcase, command.drop(1)] }
        kinds = entries.map { |name, args| Stores::Classify.redis(name, args, @reads) }
        # Classify the whole batch before the first command is written: refusing one command mid-pipeline
        # corrupts reply matching, and a queued write must never be followed by EXEC.
        entries.zip(kinds) { |(name, args), kind| Stores::Guard.guard("redis", operation(name, args), kind) }
        recorder = Capture.current
        # Session commands (AUTH, SELECT ...) and MULTI/EXEC are never logged.
        indexes = recorder ? entries.each_index.reject { |index| %i[session transaction].include?(kinds[index]) } : []
        return yield if indexes.empty?

        started = Clock.now
        begin
          result = yield
        rescue StandardError => error
          log(recorder, entries.values_at(*indexes), started, [error] * indexes.length)
          raise
        end
        log(recorder, entries.values_at(*indexes), started, errors_in(result, entries.length, indexes))
        result
      end

      private

      # The operation name the guard reports: the command, or +CONTAINER|SUB+ for a container command.
      def operation(name, _args) = name

      def build_middleware
        store = self
        Module.new do
          define_method(:call) do |command, config, &block|
            store.send(:single, self, command) { super(command, config, &block) }
          end
          define_method(:call_pipelined) do |commands, config, &block|
            store.around(commands) { super(commands, config, &block) }
          end
        end
      end

      # One command sent on its own. A write refused after +MULTI+ discards the transaction, so the
      # connection is never left with a queue that a later +EXEC+ could run.
      def single(middlewares, command)
        name = command.first.to_s.upcase
        begin
          result = around([command]) { yield }
        rescue Sendproof::PreviewWriteBlocked
          discard(middlewares) if middlewares.instance_variable_get(:@sendproof_multi)
          raise
        end
        if @active
          multi = middlewares.instance_variable_get(:@sendproof_multi)
          middlewares.instance_variable_set(:@sendproof_multi, true) if name == "MULTI"
          middlewares.instance_variable_set(:@sendproof_multi, false) if multi && %w[EXEC DISCARD].include?(name)
        end
        result
      end

      def discard(middlewares)
        middlewares.instance_variable_set(:@sendproof_multi, false)
        middlewares.client.call("DISCARD")
      rescue StandardError
        middlewares.client.close
      end

      # The command errors a pipeline's replies carry (it is read with +exception: false+ inside multi).
      def errors_in(result, count, indexes)
        return Array.new(indexes.length) unless result.is_a?(Array) && result.length == count

        indexes.map { |index| result[index].is_a?(StandardError) ? result[index] : nil }
      end

      def log(recorder, loggable, started, errors)
        elapsed = Clock.elapsed_ms(started) / loggable.length
        loggable.each_with_index do |(name, args), index|
          description = Commands.describe(name, args)
          error = errors[index]
          recorder.db(system: "redis", operation: name, target: description[:target], statement: description[:statement],
                      error: error && error_code(error), duration_ms: elapsed)
        end
      end

      def error_code(error)
        error.message.to_s.split.first.to_s[/\A[A-Z_]+\z/] || error.class.name.to_s.split("::").last
      end
    end
  end
end
