# frozen_string_literal: true

require_relative "test_helper"

class ProtocolTest < Minitest::Test
  def env(headers = {}) = Rack::MockRequest.env_for("http://app.test/x", headers)
  def request(headers = {}) = Rack::Request.new(env(headers))

  def test_requests_rollback_in_any_spelling
    ["tx=rollback", 'tx="rollback"', "TX=Rollback", "trace, tx=rollback", "x=1;tx=rollback"].each do |value|
      assert Sendproof::Protocol.requests_rollback?(env("HTTP_PREFER" => value)), value
    end
    refute Sendproof::Protocol.requests_rollback?(env("HTTP_PREFER" => "trace"))
    refute Sendproof::Protocol.requests_rollback?(env)
  end

  def test_exact_preference_is_a_single_plain_value
    assert Sendproof::Protocol.exact_preference?(env("HTTP_PREFER" => " tx=rollback "))
    ["tx=\"rollback\"", "trace, tx=rollback", "", nil].each do |value|
      refute Sendproof::Protocol.exact_preference?(env("HTTP_PREFER" => value)), value.inspect
    end
  end

  def test_trace_preference_ignores_parameters
    assert Sendproof::Protocol.requests_trace?(env("HTTP_PREFER" => "respond-async, trace;x=1"))
    refute Sendproof::Protocol.requests_trace?(env("HTTP_PREFER" => "tracing"))
  end

  def test_same_origin
    assert Sendproof::Protocol.same_origin?(request)
    assert Sendproof::Protocol.same_origin?(request("HTTP_ORIGIN" => "http://app.test"))
    assert Sendproof::Protocol.same_origin?(request("HTTP_ORIGIN" => "http://APP.test/"))
    refute Sendproof::Protocol.same_origin?(request("HTTP_ORIGIN" => "https://app.test"))
    refute Sendproof::Protocol.same_origin?(request("HTTP_ORIGIN" => "http://evil.test"))
    refute Sendproof::Protocol.same_origin?(request("HTTP_ORIGIN" => "http://app.test:81"))
    refute Sendproof::Protocol.same_origin?(request("HTTP_ORIGIN" => "http://u@app.test"))
    refute Sendproof::Protocol.same_origin?(request("HTTP_ORIGIN" => "http://app.test/path"))
    refute Sendproof::Protocol.same_origin?(request("HTTP_ORIGIN" => "null"))
    refute Sendproof::Protocol.same_origin?(request("HTTP_SEC_FETCH_SITE" => "cross-site"))
  end

  def test_problem_is_never_cacheable
    status, headers, body = Sendproof::Protocol.problem(409, "No")
    assert_equal 409, status
    assert_equal "no-store", headers["cache-control"]
    assert_equal "No", JSON.parse(body.first)["title"]
  end
end
