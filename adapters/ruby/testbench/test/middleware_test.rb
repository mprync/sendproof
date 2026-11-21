# frozen_string_literal: true

require_relative "test_helper"

# Drives the middleware over Rack with a fake provider. Covers the protocol paths and statuses.
class MiddlewareTest < Minitest::Test
  include Rack::Test::Methods
  include CoreHelpers

  PREVIEW = { "HTTP_PREFER" => "tx=rollback", "CONTENT_TYPE" => "application/json" }.freeze
  LARGE = "x" * (TestBench::Limits::RESPONSE_BYTES + 1)

  # The application behind Test Bench. Handlers call Handler.around the way a framework adapter would.
  APPLICATION = lambda do |env|
    request = Rack::Request.new(env)
    handled = ->(eligible: true, &work) { TestBench::Handler.around(env, request:, eligible:, &work) }
    case [request.request_method, env["PATH_INFO"]]
    when ["POST", "/items"]
      handled.call do
        TestBench.record_effect(:email, "Created", { to: ["a@example.test"] })
        TestBench.log("Information", "created:1")
        [201, { "content-type" => "application/json", "set-cookie" => "s=1", "location" => "/items/1", "x-kept" => "yes" },
         ['{"id":"1"}']]
      end
    when ["PATCH", "/items/9"] then handled.call { [200, { "content-type" => "text/plain" }, ["renamed"]] }
    when ["POST", "/boom"] then handled.call { raise "boom" }
    when ["POST", "/invalid"] then handled.call { raise ArgumentError, "bad" }
    when ["POST", "/large"] then handled.call { [200, { "content-type" => "text/plain" }, [LARGE]] }
    when ["POST", "/binary"] then handled.call { [200, { "content-type" => "application/octet-stream" }, ["\x00\x01".b]] }
    when ["POST", "/refused"] then handled.call(eligible: false) { [200, {}, ["never"]] }
    when ["POST", "/denied"] then [403, { "www-authenticate" => "Bearer" }, ["no"]]
    when ["POST", "/moved"] then [302, { "location" => "/login" }, []]
    when ["GET", "/plain"] then [200, { "content-type" => "text/plain" }, ["hello"]]
    else [404, {}, ["missing"]]
    end
  end

  def setup
    @provider = FakeProvider.new
    @config = build_config(identity: ->(request) { (u = request.get_header("HTTP_X_USER")) && { name: u, role: "admin", subject: u } },
                           exception_status: ->(error) { error.is_a?(ArgumentError) ? 422 : nil })
    @config.use(@provider)
    @config.preview_operations = [%w[POST /items], %w[PATCH /items/{id}], %w[POST /boom], %w[POST /invalid], %w[POST /large],
                                  %w[POST /binary], %w[POST /refused], %w[POST /denied], %w[POST /moved]]
  end

  def app
    config = @config
    Rack::Builder.app do
      use TestBench::Middleware, config
      run APPLICATION
    end
  end

  def preview(path, headers = {}, method: :post, body: "{}")
    public_send(method, "/bench/_preview#{path}", body, PREVIEW.merge(headers))
  end

  def json = JSON.parse(last_response.body)

  def assert_unconfirmed(status)
    assert_equal status, last_response.status, last_response.body
    refute_equal "tx=rollback", last_response["preference-applied"]
    refute_equal true, (JSON.parse(last_response.body)["rolledBack"] rescue nil)
  end

  # --- activation -------------------------------------------------------------------------------

  def test_nothing_is_served_until_an_environment_is_enabled
    @config.environments = []
    get "/bench/_api/capabilities"
    assert_equal 404, last_response.status
    preview("/items")
    assert_equal 404, last_response.status
    get "/plain"
    assert_equal "hello", last_response.body
  end

  def test_other_environments_do_not_enable_it
    @config.environments = %w[production]
    get "/bench/"
    assert_equal 404, last_response.status
  end

  def test_an_enabled_configuration_must_name_the_openapi_document
    assert_raises(TestBench::ConfigurationError) { TestBench::Middleware.new(APPLICATION, TestBench::Configuration.new(environments: %w[development])) }
  end

  def test_discovery_urls_must_stay_inside_the_application
    config = TestBench::Configuration.new
    %w[/fields.js /auth/sign-in?next=%2Fbench /tenant/openapi.json].each { |url| config.field_module(url) }
    ["//evil.example/x.js", "https://evil.example/x.js", "/\\evil.example", "/%2F/evil.example",
     "/\t/evil.example", "/a/../b", "/a/%2e%2e/b", "/x.js#frag", "relative.js", "/%5Cevil", "/a\nb"].each do |url|
      assert_raises(TestBench::ConfigurationError, url) { config.field_module(url) }
      assert_raises(TestBench::ConfigurationError, url) { config.auth_provider("SSO", "oidc", url) }
    end
  end

  def test_options_can_configure_the_middleware_directly
    provider = @provider
    rack = Rack::Builder.app do
      use TestBench::Middleware, environment: "test", environments: %w[test], open_api_url: "/openapi.json",
                                 ui_directory: CoreHelpers.ui_bundle, providers: [provider],
                                 preview_operations: [%w[POST /items]]
      run APPLICATION
    end
    response = Rack::MockRequest.new(rack).post("/bench/_preview/items", PREVIEW.merge(input: "{}"))
    assert_equal 200, response.status
    assert_equal "tx=rollback", response["preference-applied"]
  end

  # --- workbench --------------------------------------------------------------------------------

  def test_bench_without_a_slash_redirects_inside_the_mount
    get "/bench?from=x", {}, { "SCRIPT_NAME" => "/tenant" }
    assert_equal 302, last_response.status
    assert_equal "/tenant/bench/?from=x", last_response["location"]
  end

  def test_serves_the_ui_and_its_assets
    get "/bench/"
    assert_includes last_response.body, "Test Bench"
    get "/bench/app.js"
    assert_equal "text/javascript; charset=utf-8", last_response["content-type"]
    get "/bench/nope.js"
    assert_equal 404, last_response.status
    get "/bench/_api/unknown"
    assert_equal 404, last_response.status
  end

  def test_capabilities_describe_the_host
    @config.auth_provider("Staff", "cookie", "/auth/sign-in")
    @config.open_api_document("Admin", "/admin.json")
    @config.field_module("/assets/fields.js")
    get "/bench/_api/capabilities", {}, { "SCRIPT_NAME" => "/tenant", "HTTP_X_USER" => "Alex" }
    assert_equal "no-store", last_response["cache-control"]
    assert_equal 1, json["protocolVersion"]
    assert_equal "/tenant/openapi.json", json["openApiUrl"]
    assert_equal({ "name" => "Alex", "role" => "admin" }, json["identity"])
    assert_equal "fake", json["database"]
    assert_equal true, json["observedSend"]
    assert_equal [{ "label" => "Staff", "kind" => "cookie", "url" => "/tenant/auth/sign-in" }], json["authProviders"]
    assert_equal ["/tenant/assets/fields.js"], json["fieldModules"]
    assert_equal %w[/tenant/openapi.json /tenant/admin.json], json["documents"].map { |d| d["url"] }
    assert_includes json["previewOperations"], { "method" => "PATCH", "path" => "/items/{id}" }
  end

  def test_capabilities_for_an_anonymous_caller_have_a_null_identity
    get "/bench/_api/capabilities"
    assert_nil json["identity"]
  end

  def test_without_a_provider_nothing_is_previewable
    @config.providers.clear
    get "/bench/_api/capabilities"
    assert_equal [], json["previewOperations"]
    assert_equal false, json["observedSend"]
    assert_nil json["database"]
  end

  def test_two_providers_are_ambiguous_and_unavailable
    @config.use(FakeProvider.new)
    get "/bench/_api/capabilities"
    assert_equal [], json["previewOperations"]
  end

  def test_the_authorize_gate_protects_the_workbench
    @config.authorize = ->(request) { request.get_header("HTTP_X_USER") == "Alex" }
    get "/bench/"
    assert_equal 401, last_response.status
    get "/bench/", {}, { "HTTP_X_USER" => "Sam" }
    assert_equal 403, last_response.status
    get "/bench/", {}, { "HTTP_X_USER" => "Alex" }
    assert_equal 200, last_response.status
  end

  # --- preview transport ------------------------------------------------------------------------

  def test_preview_confirms_after_rolling_back
    preview("/items?audit=true")
    assert_equal 200, last_response.status
    assert_equal "tx=rollback", last_response["preference-applied"]
    assert_equal "no-store", last_response["cache-control"]
    assert_match %r{\Aapplication/json}, last_response["content-type"]
    assert_nil last_response["set-cookie"]
    assert_match(/auth;dur=.+handler;dur=.+db;dur=.+serialize;dur=/, last_response["server-timing"])
    assert_equal 201, json["status"]
    assert_equal({ "id" => "1" }, json["body"])
    assert_equal true, json["rolledBack"]
    assert_equal({ "content-type" => "application/json", "x-kept" => "yes" }, json["headers"], "hop-by-hop and private headers are dropped")
    assert_equal [:rollback, :close], @provider.sessions.first.log
  end

  def test_effects_are_suppressed_and_logs_captured
    preview("/items")
    assert_equal [{ "kind" => "email", "description" => "Created", "data" => { "to" => ["a@example.test"] } }], json["effects"]
    refute json["effects"].first.key?("delivered")
    assert(json["logs"].any? { |log| log["message"] == "created:1" && log["level"] == "Information" })
  end

  def test_the_envelope_includes_provider_changes
    @provider = FakeProvider.new(changes: [{ operation: "insert", table: "items", key: { "id" => "1" }, before: nil, after: { "id" => "1" } }])
    @config.providers.replace([@provider])
    preview("/items")
    assert_equal [{ "operation" => "insert", "table" => "items", "key" => { "id" => "1" }, "before" => nil, "after" => { "id" => "1" } }],
                 json["changes"]
  end

  def test_text_and_binary_bodies
    preview("/items/9", {}, method: :patch)
    assert_equal "renamed", json["body"]
    preview("/binary")
    assert_equal "AAE=", json["body"]
  end

  def test_requires_the_exact_preference
    ["", "tx=\"rollback\"", "trace, tx=rollback", "tx=commit"].each do |value|
      post "/bench/_preview/items", "{}", { "HTTP_PREFER" => value }
      assert_unconfirmed 400
    end
    post "/bench/_preview/items", "{}"
    assert_unconfirmed 400
    assert_empty @provider.sessions
  end

  def test_rollback_preference_on_the_real_url_is_refused
    post "/items", "{}", PREVIEW
    assert_unconfirmed 400
  end

  def test_head_is_refused
    head "/bench/_preview/items", {}, PREVIEW
    assert_equal 405, last_response.status
  end

  def test_invalid_targets_are_refused_before_dispatch
    ["", "//items", "/bench/_api/capabilities", "/bench", "/a/../items", "/a/./items", "/a%5Cb", "/%2E%2E/items", "/it%00ems", "/%ff"].each do |target|
      preview(target)
      assert_includes [400, 404], last_response.status, target
      refute_equal "tx=rollback", last_response["preference-applied"], target
    end
    assert_empty @provider.sessions
  end

  def test_cross_origin_requests_are_refused
    preview("/items", { "HTTP_ORIGIN" => "https://elsewhere.test" })
    assert_unconfirmed 403
    preview("/items", { "HTTP_SEC_FETCH_SITE" => "cross-site" })
    assert_unconfirmed 403
    assert_empty @provider.sessions
  end

  def test_unknown_targets_are_not_found_and_open_no_session
    preview("/nope")
    assert_unconfirmed 404
    assert_empty @provider.sessions
  end

  def test_the_workbench_policy_gates_previews
    @config.authorize = ->(request) { request.get_header("HTTP_X_USER") }
    preview("/items")
    assert_unconfirmed 401
    preview("/items", { "HTTP_X_USER" => "Alex" })
    assert_equal 200, last_response.status
  end

  def test_missing_or_unavailable_providers_return_503
    @provider.available = false
    preview("/items")
    assert_unconfirmed 503
  end

  def test_a_rejected_request_never_reaches_the_handler
    preview("/denied")
    assert_unconfirmed 403
    assert_equal "Bearer", last_response["www-authenticate"]
    preview("/moved")
    assert_unconfirmed 401
    preview("/refused")
    assert_unconfirmed 409
    assert_equal [:rollback, :close], @provider.sessions.first.log, "the empty transaction is still rolled back"
  end

  def test_an_unhandled_exception_is_unconfirmed_and_rolled_back
    preview("/boom")
    assert_unconfirmed 500
    assert_equal [:rollback, :close], @provider.sessions.first.log
  end

  def test_a_mapped_client_error_is_a_confirmed_inner_response
    preview("/invalid")
    assert_equal 200, last_response.status
    assert_equal 422, json["status"]
    assert_equal true, json["rolledBack"]
  end

  def test_an_oversized_response_is_refused
    preview("/large")
    assert_unconfirmed 413
    assert_equal [:rollback, :close], @provider.sessions.first.log
  end

  def test_a_failed_rollback_withholds_confirmation
    @provider = FakeProvider.new(rollback_error: RuntimeError.new("rollback failed"))
    @config.providers.replace([@provider])
    preview("/items")
    assert_unconfirmed 500
    assert_equal [:rollback, :close], @provider.sessions.first.log
  end

  def test_a_provider_that_cannot_begin_fails_cleanly
    @provider.begin_error = RuntimeError.new("no connection")
    preview("/items")
    assert_unconfirmed 500
  end

  def test_the_session_is_not_committed_by_the_outer_response
    options = {}
    preview("/items", { "rack.session.options" => options })
    assert_equal true, options[:skip]
  end

  def test_capture_does_not_leak_after_the_request
    preview("/items")
    refute TestBench.capturing?
    assert_equal false, TestBench.record_effect(:email, "x")
  end

  # --- observed send ----------------------------------------------------------------------------

  def send_observed(headers = {})
    post "/items", "{}", { "CONTENT_TYPE" => "application/json", "HTTP_PREFER" => "trace" }.merge(headers)
  end

  def test_observed_send_keeps_the_response_and_adds_a_trace
    send_observed("HTTP_X_USER" => "Alex")
    assert_equal 201, last_response.status
    assert_equal({ "id" => "1" }, json)
    trace_id = last_response["x-testbench-trace"]
    assert_match(/\A\h{32}\z/, trace_id)
    assert_equal "no-store", last_response["cache-control"]
    assert_match(/serialize;dur=/, last_response["server-timing"])

    get "/bench/_api/traces/#{trace_id}", {}, { "HTTP_X_USER" => "Alex" }
    assert_equal 200, last_response.status
    assert_equal "no-store", last_response["cache-control"]
    assert_equal [{ "kind" => "email", "description" => "Created", "data" => { "to" => ["a@example.test"] }, "delivered" => true }],
                 json["effects"]
    assert(json["logs"].any? { |log| log["message"] == "created:1" })
    assert_equal %w[auth db handler queryCount serialize], json["timing"].keys.sort
  end

  def test_traces_belong_to_their_owner
    send_observed("HTTP_X_USER" => "Alex")
    trace_id = last_response["x-testbench-trace"]
    get "/bench/_api/traces/#{trace_id}", {}, { "HTTP_X_USER" => "Sam" }
    assert_equal 404, last_response.status
    get "/bench/_api/traces/#{trace_id}"
    assert_equal 404, last_response.status
    get "/bench/_api/traces/#{trace_id}", {}, { "HTTP_X_USER" => "Alex", "HTTP_ORIGIN" => "https://elsewhere.test" }
    assert_equal 404, last_response.status
  end

  def test_traces_expire_with_the_injected_clock
    now = 10.0
    @config.trace_clock = -> { now }
    send_observed("HTTP_X_USER" => "Alex")
    trace_id = last_response["x-testbench-trace"]
    now += 299
    get "/bench/_api/traces/#{trace_id}", {}, { "HTTP_X_USER" => "Alex" }
    assert_equal 200, last_response.status
    now += 2
    get "/bench/_api/traces/#{trace_id}", {}, { "HTTP_X_USER" => "Alex" }
    assert_equal 404, last_response.status
  end

  def test_observed_send_requires_a_subject_and_a_same_origin_request
    send_observed
    assert_equal 201, last_response.status
    assert_nil last_response["x-testbench-trace"]
    send_observed("HTTP_X_USER" => "Alex", "HTTP_ORIGIN" => "https://elsewhere.test")
    assert_equal 201, last_response.status
    assert_nil last_response["x-testbench-trace"]
    assert_empty @provider.observations
  end

  def test_observed_send_commits_nothing_and_closes_its_observation
    send_observed("HTTP_X_USER" => "Alex")
    assert_empty @provider.sessions
    assert @provider.observations.first.closed
  end

  def test_a_failed_observed_send_leaves_no_trace
    assert_raises(RuntimeError) { post "/boom", "{}", { "HTTP_PREFER" => "trace", "HTTP_X_USER" => "Alex" } }
    assert @provider.observations.first.closed
  end

  def test_unmarked_endpoints_are_not_observed
    get "/plain", {}, { "HTTP_PREFER" => "trace", "HTTP_X_USER" => "Alex" }
    assert_nil last_response["x-testbench-trace"]
  end
end
