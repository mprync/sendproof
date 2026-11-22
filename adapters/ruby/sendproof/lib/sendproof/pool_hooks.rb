# frozen_string_literal: true

module Sendproof
  # Makes a Preview's inherited mark (see {Capture.inherited_preview}) follow the task, not the pool thread.
  #
  # A thread inherits the fiber storage of the thread that creates it, so a pool worker that happens to be
  # created while a Preview's handler posts to the pool would carry that Preview for its whole life and have
  # every later write refused. Each hook below runs every task with the inherited mark cleared, so a task
  # posted during a Preview counts as unattributed (refused while a Preview is open) and later tasks run
  # normally (spec/data-stores.md, "Writes the binding can't attribute to a request").
  #
  # Hooked: concurrent-ruby's thread pools (+ThreadPoolExecutor+, +CachedThreadPool+, +FixedThreadPool+,
  # +SingleThreadExecutor+ and the global executors behind +Concurrent::Promises+, +Future+, +TimerSet+ and
  # +ScheduledTask+), its +SimpleExecutorService+, and work wrapped in the Rails executor
  # (+ActiveSupport::Executor.wrap+), which covers ActiveJob's +:async+ adapter, job execution and Action Cable.
  # {install} runs as each Preview starts, so a library loaded later is hooked before its first Preview.
  module PoolHooks
    # Runs a task with the inherited Preview mark cleared.
    module ClearedTask
      def run_task(...)
        Sendproof::Capture.without_inherited { super }
      end
    end

    # +SimpleExecutorService+ starts a new thread per task, on the posting thread.
    module ClearedPost
      def post(*args, &task)
        return super unless task

        super(*args) { |*inner| Sendproof::Capture.without_inherited { task.call(*inner) } }
      end
    end

    # The outermost +ActiveSupport::ExecutionWrapper.wrap+ starts a unit of work of its own.
    module ClearedWrap
      def wrap(...)
        return super if active?

        Sendproof::Capture.without_inherited { super }
      end
    end

    @lock = Mutex.new
    @installed = {}

    class << self
      # Prepends each hook whose library is loaded, once.
      def install
        return if @installed.length == 3

        @lock.synchronize do
          hook(:pool) { pool_worker_class&.prepend(ClearedTask) }
          hook(:simple) do
            if defined?(::Concurrent::SimpleExecutorService)
              ::Concurrent::SimpleExecutorService.prepend(ClearedPost)
              ::Concurrent::SimpleExecutorService.singleton_class.prepend(ClearedPost)
            end
          end
          hook(:rails) { ::ActiveSupport::ExecutionWrapper.singleton_class.prepend(ClearedWrap) if defined?(::ActiveSupport::ExecutionWrapper) }
        end
      end

      private

      def hook(name)
        @installed[name] = true if !@installed[name] && yield
      end

      # The private worker class of concurrent-ruby's Ruby thread pool, the one every MRI pool uses.
      def pool_worker_class
        return nil unless defined?(::Concurrent::RubyThreadPoolExecutor)

        worker = ::Concurrent::RubyThreadPoolExecutor.const_get(:Worker, false)
        worker if worker.private_method_defined?(:run_task) || worker.method_defined?(:run_task)
      rescue NameError
        nil
      end
    end
  end
end
