# frozen_string_literal: true

require_relative "test_helper"

# Shared harness for the data-store hook suites: running a block as a Preview or an observed send, and
# skipping a test when its compose service isn't answering a real protocol request.
module StoreHelpers
  include CoreHelpers

  COMPOSE = "docker compose -f tests/conformance/compose.yml up -d --wait mongodb redis dynamodb"

  SERVERS = {
    redis: ENV.fetch("BENCH_REDIS_SERVER_URL", "redis://:bench_redis_local@127.0.0.1:56379"),
    mongodb: ENV.fetch("BENCH_MONGODB_SERVER_URL", "mongodb://127.0.0.1:57017/?directConnection=true"),
    dynamodb: ENV.fetch("BENCH_DYNAMODB_SERVER_URL", "http://127.0.0.1:58000")
  }.freeze

  # A short, unique name per test, so tests never see each other's keys, documents or tables.
  def unique(prefix = "tb") = "#{prefix}_#{SecureRandom.hex(5)}"

  # Runs the block as a request handler inside a Preview and returns the recorder, whose +blocked+ and
  # +fault+ marks decide the outcome, exactly as the transport reads them. The block's own errors
  # propagate. Stores begin before the block and finish after it, in the transport's order.
  def preview(store_hooks = [], &block)
    recorder = Sendproof::Recorder.new(rollback: true, include_sql_values: true)
    Sendproof::Attribution.open(recorder)
    Sendproof::Capture.with(recorder) do
      store_hooks.each { |hook| hook.begin_preview(nil, recorder) }
      begin
        block.call(recorder)
      ensure
        begin
          store_hooks.reverse_each { |hook| hook.finish_preview(recorder) }
        ensure
          remember(recorder)
        end
      end
    end
    recorder
  ensure
    Sendproof::Attribution.close(recorder) if recorder
  end

  # Runs the block as an observed send: capturing, but writes commit.
  def observe(&block)
    recorder = Sendproof::Recorder.new(rollback: false, include_sql_values: true)
    begin
      Sendproof::Capture.with(recorder, &block)
    ensure
      remember(recorder)
    end
    recorder
  end

  # Finishes +recorder+ and keeps what it captured for {#captured}.
  def remember(recorder)
    (@snapshots ||= {}.compare_by_identity)[recorder] ||= recorder.finish
  end

  # What a finished recorder captured: +logs+, +changes+ and so on.
  def captured(recorder) = (@snapshots ||= {}.compare_by_identity)[recorder] || remember(recorder)

  # The +Db+ log entries of a finished recorder, optionally of one operation.
  def db_entries(recorder, operation = nil)
    entries = captured(recorder).logs.select { |entry| entry[:level] == "Db" }
    operation ? entries.select { |entry| entry[:db][:operation].casecmp?(operation) } : entries
  end

  # Asserts a block is refused by the guard and marks the Preview blocked.
  def assert_blocked_in_preview(store, operation, hooks = [], &block)
    recorder = preview(hooks) do |current|
      assert_raises(Sendproof::PreviewWriteBlocked) { block.call(current) }
    end
    assert_equal store, recorder.blocked&.store
    assert_equal operation.upcase, recorder.blocked&.operation.to_s.upcase
    recorder
  end

  # Skips the test unless +store+'s compose service answers a real request. An open port isn't enough:
  # Docker accepts and drops connections while a container starts.
  def needs(store)
    return if (@@reachable ||= {}).fetch(store) { @@reachable[store] = probe(store) }

    skip "#{store} is not answering; start it with: #{COMPOSE}"
  end

  private

  def probe(store)
    case store
    when :redis
      client = RedisClient.new(url: SERVERS[:redis], timeout: 1, reconnect_attempts: 0)
      client.call("PING") == "PONG"
    when :mongodb
      client = Mongo::Client.new(SERVERS[:mongodb], server_selection_timeout: 2, connect_timeout: 2, monitoring: false)
      client.database.command(hello: 1).first["ok"] == 1
    when :dynamodb
      Net::HTTP.start(URI(SERVERS[:dynamodb]).host, URI(SERVERS[:dynamodb]).port, open_timeout: 1, read_timeout: 1) { |http| http.get("/") }
      true
    end
  rescue StandardError
    false
  ensure
    client&.close
  end
end
