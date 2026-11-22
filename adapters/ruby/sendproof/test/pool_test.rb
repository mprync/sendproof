# frozen_string_literal: true

require_relative "test_helper"
require "concurrent"
require "active_support"
require "active_support/execution_wrapper"

# A Preview's mark follows the task, not the pool thread (spec/data-stores.md, "Writes the binding can't
# attribute to a request"): a pool worker that happened to start during a Preview must not have every later
# write refused. Each test starts a Preview, lets a pool or wrapper pick up its mark, ends the Preview, then
# writes through that pool the way an ordinary request or background job would.
class PoolTest < Minitest::Test
  # What a hooked client does: guard, then send.
  def write(sent, name = "k")
    Sendproof::Stores::Guard.guard("redis", "INCR", :write)
    sent << name
    :sent
  rescue Sendproof::PreviewWriteBlocked => e
    e
  end

  def setup
    @sent = Queue.new
    @recorder = Sendproof::Recorder.new(rollback: true)
    Sendproof::Attribution.open(@recorder)
  end

  def teardown
    end_preview
    @pool&.shutdown
    @pool&.wait_for_termination(5)
  end

  def end_preview
    Sendproof::Attribution.close(@recorder)
    @recorder.finish
  end

  def in_preview(&) = Sendproof::Capture.with(@recorder, &)

  def lazy_pool = (@pool = Concurrent::ThreadPoolExecutor.new(min_threads: 0, max_threads: 1, idletime: 60))

  def test_a_pool_worker_started_during_a_preview_runs_a_later_ordinary_task_unrefused
    pool = lazy_pool
    in_preview { pool.post { :warm } } # the worker thread is created here, on the handler's thread
    sleep 0.01 until pool.completed_task_count == 1
    end_preview
    result = Queue.new
    Sendproof::Attribution.request { pool.post { result << write(@sent, "ordinary") } }
    assert_equal :sent, result.pop, "a worker that started during a Preview must not refuse later work"
    assert_equal 1, pool.largest_length, "the same worker ran both tasks"
    assert_equal "ordinary", @sent.pop
  end

  def test_a_task_posted_during_an_open_preview_counts_as_unattributed
    pool = lazy_pool
    result = Queue.new
    in_preview { pool.post { result << write(@sent) } }
    assert_kind_of Sendproof::PreviewWriteBlocked, result.pop, "refused while a Preview is open"
    assert_equal "INCR", @recorder.blocked&.operation
    assert @sent.empty?
  end

  def test_a_promise_on_a_pool_started_during_a_preview_runs_unrefused_afterwards
    pool = lazy_pool
    in_preview { Concurrent::Promises.future_on(pool) { :warm }.wait }
    end_preview
    assert_equal :sent, Concurrent::Promises.future_on(pool) { write(@sent) }.value!
  end

  def test_a_simple_executor_task_follows_its_own_attribution
    go = Queue.new
    result = Queue.new
    in_preview { Concurrent::SimpleExecutorService.post { go.pop; result << write(@sent) } }
    end_preview
    go << true
    assert_equal :sent, result.pop
  end

  # Work wrapped in the Rails executor (jobs, Action Cable, a thread that wraps its own work) is a task of
  # its own: it doesn't carry the mark of the Preview whose handler happened to start its thread.
  def test_work_wrapped_in_the_rails_executor_does_not_carry_the_preview
    go = Queue.new
    worker = in_preview { Thread.new { go.pop; ActiveSupport::Executor.wrap { write(@sent) } } }
    end_preview
    go << true
    assert_equal :sent, worker.value
  end

  # A thread the handler started itself, outside any pool or wrapper, keeps the mark.
  def test_a_plain_thread_the_handler_started_keeps_the_mark
    go = Queue.new
    worker = in_preview { Thread.new { go.pop; write(@sent) } }
    end_preview
    go << true
    assert_kind_of Sendproof::PreviewWriteBlocked, worker.value
  end
end
