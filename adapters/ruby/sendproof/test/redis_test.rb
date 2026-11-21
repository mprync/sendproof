# frozen_string_literal: true

require_relative "stores_support"
require "net/http"
require "sendproof/redis"

# The Redis hook against the compose Redis (docker compose -f tests/conformance/compose.yml up -d --wait redis).
class RedisHookTest < Minitest::Test
  include StoreHelpers
  include Rack::Test::Methods

  def setup
    needs(:redis)
    @prefix = "#{unique}:"
    @store = Sendproof::Redis::Store.new(name: "cache")
    @client = RedisClient.new(url: SERVERS[:redis], timeout: 2)
  end

  def teardown
    @store&.unhook!
    return unless @client

    keys = @client.call("KEYS", "#{@prefix}*")
    @client.call("DEL", *keys) unless keys.empty?
    @client.close
  end

  def key(name) = "#{@prefix}#{name}"

  # A read straight from the server, outside any Preview: what is really stored.
  def stored(name) = @client.call("GET", key(name))

  def test_a_read_in_a_preview_runs_and_is_logged_without_its_values
    @client.call("SET", key("seeded"), "5")
    recorder = preview { |_| assert_equal "5", @client.call("GET", key("seeded")) }
    assert_nil recorder.blocked
    entry = db_entries(recorder, "GET").fetch(0)
    assert_equal "GET #{key('seeded')}", entry[:db][:statement]
    assert_equal key("seeded"), entry[:db][:target]
  end

  def test_a_write_is_refused_before_it_reaches_redis
    recorder = assert_blocked_in_preview("redis", "INCR") { @client.call("INCR", key("counter")) }
    assert_nil stored("counter"), "INCR must not reach Redis"
    assert_equal "Preview unavailable: this operation writes to Redis", recorder.blocked.detail
    assert(db_entries(recorder, "INCR").first[:db][:blocked])
  end

  def test_getdel_and_scripts_that_look_like_reads_are_writes
    @client.call("SET", key("seeded"), "5")
    assert_blocked_in_preview("redis", "GETDEL") { @client.call("GETDEL", key("seeded")) }
    assert_blocked_in_preview("redis", "EVAL") { @client.call("EVAL", "return redis.call('DEL', KEYS[1])", 1, key("seeded")) }
    assert_equal "5", stored("seeded")
    # EVAL_RO is a read: the server refuses writes inside it.
    preview { |_| assert_equal 1, @client.call("EVAL_RO", "return 1", 0) }
  end

  def test_a_pipeline_with_a_write_is_refused_before_the_first_command_is_written
    assert_blocked_in_preview("redis", "SET") do
      @client.pipelined { |pipeline| pipeline.call("SET", key("a"), "1"); pipeline.call("GET", key("b")) }
    end
    assert_nil stored("a")
  end

  def test_a_multi_with_a_queued_write_never_reaches_exec
    assert_blocked_in_preview("redis", "INCR") { @client.multi { |tx| tx.call("GET", key("a")); tx.call("INCR", key("a")) } }
    assert_nil stored("a")
  end

  def test_a_write_after_a_bare_multi_discards_the_transaction
    preview do |_|
      @client.call("MULTI")
      assert_raises(Sendproof::PreviewWriteBlocked) { @client.call("INCR", key("a")) }
    end
    # The connection is no longer inside MULTI: this runs now instead of answering QUEUED.
    assert_equal "PONG", @client.call("PING")
    assert_nil stored("a")
  end

  # A pubsub connection writes commands straight to its socket, past the middleware, and Redis runs any
  # command sent on it. Each is classified before it is written; SUBSCRIBE and PUBLISH are writes.
  def test_commands_on_a_pubsub_connection_are_refused_before_they_are_written
    pubsub = @client.pubsub
    recorder = preview do |_|
      assert_raises(Sendproof::PreviewWriteBlocked) { pubsub.call("SET", key("pubsub"), "1") }
      assert_raises(Sendproof::PreviewWriteBlocked) { pubsub.call_v(["PUBLISH", key("channel"), "hello"]) }
      assert_raises(Sendproof::PreviewWriteBlocked) { pubsub.call("SUBSCRIBE", key("channel")) }
    end
    assert_equal "SET", recorder.blocked.operation
    sleep 0.05
    assert_nil stored("pubsub"), "The SET must never reach Redis"
  ensure
    pubsub&.close
  end

  def test_a_per_client_store_guards_the_pubsub_connections_of_its_client_only
    @store.unhook!
    @store = Sendproof::Redis::Store.new(global: false)
    guarded = RedisClient.config(url: SERVERS[:redis], middlewares: [@store.middleware]).new_client
    guarded_pubsub = guarded.pubsub
    other_pubsub = @client.pubsub
    preview do |_|
      assert_raises(Sendproof::PreviewWriteBlocked) { guarded_pubsub.call("SET", key("guarded"), "1") }
      other_pubsub.call("SET", key("other"), "1")
    end
    sleep 0.05
    assert_nil stored("guarded")
    assert_equal "1", stored("other")
  ensure
    [guarded_pubsub, other_pubsub, guarded].compact.each(&:close)
  end

  def test_the_first_block_wins_and_later_writes_are_refused_too
    recorder = preview do |_|
      assert_raises(Sendproof::PreviewWriteBlocked) { @client.call("INCR", key("a")) }
      assert_raises(Sendproof::PreviewWriteBlocked) { @client.call("SET", key("b"), "1") }
    end
    assert_equal "INCR", recorder.blocked.operation
  end

  def test_a_handler_that_swallows_the_error_still_leaves_the_preview_blocked
    recorder = preview do |_|
      begin
        @client.call("INCR", key("a"))
      rescue Sendproof::PreviewWriteBlocked
        nil
      end
    end
    refute_nil recorder.blocked
    assert_nil stored("a")
  end

  def test_observed_send_commits_once_and_traces_the_command
    recorder = observe { assert_equal 1, @client.call("INCR", key("sent")) }
    assert_equal "1", stored("sent")
    assert_equal 1, db_entries(recorder, "INCR").length
    assert_nil recorder.blocked
  end

  def test_writes_outside_any_capture_are_never_blocked
    assert_equal 1, @client.call("INCR", key("plain"))
  end

  def test_the_password_and_session_commands_never_reach_a_capture
    # A fresh connection authenticates (HELLO ... AUTH) inside the capture.
    fresh = RedisClient.new(url: SERVERS[:redis], timeout: 2)
    recorder = preview { |_| fresh.call("GET", key("x")) }
    fresh.close
    password = URI(SERVERS[:redis]).password
    json = JSON.generate(captured(recorder).logs)
    refute_includes json, password
    refute(db_entries(recorder).any? { |entry| %w[AUTH HELLO SELECT].include?(entry[:db][:operation]) })
  end

  def test_host_declared_reads_pass_the_guard_by_exact_name
    @store.unhook!
    @store = Sendproof::Redis::Store.new(treat_as_read: ["MYMODULE.GET"])
    preview do |_|
      # The guard lets it through, so the server (which has no such module) is what rejects it.
      assert_raises(RedisClient::CommandError) { @client.call("MYMODULE.GET", key("a")) }
      assert_raises(Sendproof::PreviewWriteBlocked) { @client.call("MYMODULE.SET", key("a"), "1") }
    end
  end

  def test_a_second_global_store_is_refused_until_the_first_is_unhooked
    assert_raises(Sendproof::ConfigurationError) { Sendproof::Redis::Store.new }
    @store.unhook!
    @store = Sendproof::Redis::Store.new
  end

  def test_a_per_client_store_guards_only_the_client_it_was_added_to
    @store.unhook!
    @store = Sendproof::Redis::Store.new(global: false)
    guarded = RedisClient.config(url: SERVERS[:redis], middlewares: [@store.middleware]).new_client
    preview do |_|
      assert_raises(Sendproof::PreviewWriteBlocked) { guarded.call("INCR", key("a")) }
      assert_equal 1, @client.call("INCR", key("b")), "a client without the middleware is not covered"
    end
    guarded.close
    assert_nil stored("a")
  end

  def test_the_redis_gem_is_covered_through_redis_client
    require "redis"
    redis = Redis.new(url: SERVERS[:redis])
    recorder = preview do |_|
      assert_raises(Sendproof::PreviewWriteBlocked) { redis.incr(key("gem")) }
      assert_equal 0, redis.exists(key("gem"))
    end
    assert_equal "INCR", recorder.blocked.operation
    assert_nil stored("gem")
    redis.close
  end

  def test_the_guard_checks_fail_when_the_hook_is_removed
    @store.unhook!
    recorder = preview { |_| @client.call("INCR", key("unhooked")) }
    assert_nil recorder.blocked, "Without the hook nothing is refused"
    assert_equal "1", stored("unhooked"), "and the write reaches Redis"
  end

  def test_discovery_lists_the_store_in_guard_mode
    assert_equal({ system: "redis", name: "cache", mode: :guard }, @store.describe)
  end

  # Through the real Rack transport: the handler swallows the refusal and answers 200, the Preview answers 409.
  def app
    client = @client
    key = method(:key)
    config = build_config
    config.use(CoreHelpers::FakeProvider.new)
    config.data_store(@store)
    config.preview_operations = [%w[POST /counters/{key}]]
    config.identity = ->(request) { { name: "a", subject: "a" } if request.get_header("HTTP_X_USER") }
    application = lambda do |env|
      request = Rack::Request.new(env)
      Sendproof::Handler.around(env, request:, eligible: true) do
        begin
          client.call("INCR", key.call("rack"))
        rescue Sendproof::PreviewWriteBlocked
          nil
        end
        [200, { "content-type" => "application/json" }, ['{"swallowed":true}']]
      end
    end
    Rack::Builder.app { use Sendproof::Middleware, config; run application }
  end

  def test_a_blocked_preview_answers_409_through_the_transport_even_when_the_handler_swallows_the_error
    post "/sendproof/_preview/counters/rack", "{}", { "HTTP_PREFER" => "tx=rollback", "CONTENT_TYPE" => "application/json", "HTTP_X_USER" => "a" }
    assert_equal 409, last_response.status, last_response.body
    assert_nil last_response["preference-applied"]
    body = JSON.parse(last_response.body)
    assert_equal({ "store" => "redis", "operation" => "INCR", "rolledBack" => false }, body.slice("store", "operation", "rolledBack"))
    assert_nil stored("rack")
  end
end
