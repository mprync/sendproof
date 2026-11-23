# frozen_string_literal: true

require_relative "test_helper"

class PreviewSessionsTest < Minitest::Test
  include CoreHelpers

  ROUTE = "/sendproof/_api/sessions"
  Part = Struct.new(:closed) do
    def close = closed.push(Thread.current)
  end

  def setup
    @config = build_config(identity: ->(request) { { subject: request.get_header("HTTP_X_OWNER") } })
    @opened, @closed = Queue.new, Queue.new
    provider = Sendproof::Provider::None.new
    opened, closed = @opened, @closed
    provider.define_singleton_method(:begin_held_preview) do |_context|
      opened.push(Thread.current)
      Part.new(closed)
    end
    @config.use(provider)
    @sessions = Sendproof::PreviewSessions.new(@config, idle_timeout: 1, max_lifetime: 8)
  end

  def teardown = @sessions.shutdown

  def request(headers = {})
    Rack::Request.new(Rack::MockRequest.env_for(ROUTE, { method: "POST", "HTTP_X_OWNER" => "owner" }.merge(headers)))
  end

  def open(req = request)
    status, _, body = @sessions.call(req.env, req, nil, nil)
    [status, JSON.parse(body.join)]
  end

  def test_idle_expiry_releases_resources_without_another_request
    status, payload = open
    assert_equal 201, status
    assert_equal @opened.pop, @closed.pop(timeout: 3)
    assert_equal 404, @sessions.with_session(request, payload.fetch("id")) { flunk }.first
  end

  def test_shutdown_rolls_back_on_the_workers_and_refuses_new_sessions
    assert_equal 201, open.first
    assert_equal 201, open.first
    @sessions.shutdown
    assert_equal 2, @closed.size
    assert_equal 409, open.first
  end

  def test_owner_limit_and_cross_origin_have_problem_codes
    ids = Array.new(4) { open.last.fetch("id") }
    status, payload = open
    assert_equal [429, "session_limit"], [status, payload["code"]]

    for caller in [request("HTTP_X_OWNER" => "other"), request("HTTP_ORIGIN" => "https://other.test")]
      status, _, body = @sessions.with_session(caller, ids.first) { flunk }
      assert_equal 404, status
      assert_equal "session_not_found", JSON.parse(body.join)["code"]
    end
    assert_equal 403, open(request("HTTP_X_OWNER" => nil)).first
  end

  def test_acquiring_a_second_store_failure_rolls_back_the_first
    store = Struct.new(:system, :describe).new("test", { mode: :preview })
    store.define_singleton_method(:begin_held_preview) { |_context| raise "unavailable" }
    @config.data_store(store)
    status, payload = open
    assert_equal [409, "session_failed"], [status, payload["code"]]
    assert_equal @opened.pop, @closed.pop(timeout: 1)
  end

  def test_rack_session_gets_honor_the_explicit_unavailable_list
    @config.providers = [Sendproof::Provider::None.new]
    @config.preview_unavailable = [{ method: "GET", path: "/blocked", reason: "Send only" }]
    handler = lambda do |env|
      Sendproof::Handler.around(env, eligible: false) { [200, { "content-type" => "text/plain" }, ["handled"]] }
    end
    middleware = Sendproof::Middleware.new(handler, @config)
    client = Rack::MockRequest.new(middleware)
    headers = { "HTTP_X_OWNER" => "owner", "HTTP_PREFER" => "tx=rollback" }
    assert_equal 404, client.get("/sendproof/_preview/read", headers).status

    opened = client.post(ROUTE, headers.reject { |name, _| name == "HTTP_PREFER" })
    assert_equal 201, opened.status
    headers["HTTP_SENDPROOF_SESSION"] = JSON.parse(opened.body).fetch("id")
    assert_equal 409, client.get("/sendproof/_preview/blocked", headers).status
    result = client.get("/sendproof/_preview/read", headers)
    assert_equal 200, result.status
    assert_equal "handled", JSON.parse(result.body).fetch("body")
    assert_equal 1, JSON.parse(result.body).dig("session", "step")
  ensure
    middleware&.close
  end
end
