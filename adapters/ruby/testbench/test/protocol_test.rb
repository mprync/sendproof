# frozen_string_literal: true

require_relative "test_helper"

class ProtocolTest < Minitest::Test
  def env(headers = {}) = Rack::MockRequest.env_for("http://app.test/x", headers)
  def request(headers = {}) = Rack::Request.new(env(headers))

  def test_requests_rollback_in_any_spelling
    ["tx=rollback", 'tx="rollback"', "TX=Rollback", "trace, tx=rollback", "x=1;tx=rollback"].each do |value|
      assert TestBench::Protocol.requests_rollback?(env("HTTP_PREFER" => value)), value
    end
    refute TestBench::Protocol.requests_rollback?(env("HTTP_PREFER" => "trace"))
    refute TestBench::Protocol.requests_rollback?(env)
  end

  def test_exact_preference_is_a_single_plain_value
    assert TestBench::Protocol.exact_preference?(env("HTTP_PREFER" => " tx=rollback "))
    ["tx=\"rollback\"", "trace, tx=rollback", "", nil].each do |value|
      refute TestBench::Protocol.exact_preference?(env("HTTP_PREFER" => value)), value.inspect
    end
  end

  def test_trace_preference_ignores_parameters
    assert TestBench::Protocol.requests_trace?(env("HTTP_PREFER" => "respond-async, trace;x=1"))
    refute TestBench::Protocol.requests_trace?(env("HTTP_PREFER" => "tracing"))
  end

  def test_same_origin
    assert TestBench::Protocol.same_origin?(request)
    assert TestBench::Protocol.same_origin?(request("HTTP_ORIGIN" => "http://app.test"))
    assert TestBench::Protocol.same_origin?(request("HTTP_ORIGIN" => "http://APP.test/"))
    refute TestBench::Protocol.same_origin?(request("HTTP_ORIGIN" => "https://app.test"))
    refute TestBench::Protocol.same_origin?(request("HTTP_ORIGIN" => "http://evil.test"))
    refute TestBench::Protocol.same_origin?(request("HTTP_ORIGIN" => "http://app.test:81"))
    refute TestBench::Protocol.same_origin?(request("HTTP_ORIGIN" => "http://u@app.test"))
    refute TestBench::Protocol.same_origin?(request("HTTP_ORIGIN" => "http://app.test/path"))
    refute TestBench::Protocol.same_origin?(request("HTTP_ORIGIN" => "null"))
    refute TestBench::Protocol.same_origin?(request("HTTP_SEC_FETCH_SITE" => "cross-site"))
  end

  def test_problem_is_never_cacheable
    status, headers, body = TestBench::Protocol.problem(409, "No")
    assert_equal 409, status
    assert_equal "no-store", headers["cache-control"]
    assert_equal "No", JSON.parse(body.first)["title"]
  end
end
