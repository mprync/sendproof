# frozen_string_literal: true

require_relative "test_helper"

class RoutesTest < Minitest::Test
  def operations = Sendproof::Rails::Routes.operations

  def test_path_templates_use_openapi_syntax
    {
      "/items/:id(.:format)" => "/items/{id}",
      "/items(.:format)" => "/items",
      "/a/:parent_id/b/:id(.:format)" => "/a/{parent_id}/b/{id}",
      "/files/*path(.:format)" => "/files/{path}",
      "/search(/:q)(.:format)" => "/search"
    }.each { |spec, expected| assert_equal expected, Sendproof::Rails::Routes.template(spec), spec }
  end

  def test_only_marked_actions_become_operations
    assert_includes operations, ["POST", "/items"]
    assert_includes operations, ["PATCH", "/items/{id}"]
    assert_includes operations, ["PUT", "/items/{id}"]
    assert_includes operations, ["POST", "/items/{id}/touch"]
    assert_includes operations, ["POST", "/items/boom"]
    refute_includes operations, ["GET", "/items"]
    refute_includes operations, ["DELETE", "/items/{id}"]
  end

  def test_a_bare_marker_enables_every_action_and_except_removes_one
    assert_includes operations, ["POST", "/open/ping"]
    assert_includes operations, ["POST", "/partial/shown"]
    refute_includes operations, ["POST", "/partial/hidden"]
  end

  def test_markers_are_inherited
    assert_includes operations, ["POST", "/child/inherited"]
  end

  def test_mounted_rack_apps_are_never_operations
    refute(operations.any? { |_, path| path.start_with?("/engine") })
  end

  def test_resolve_distinguishes_eligible_ineligible_and_unknown
    assert_equal :eligible, Sendproof::Rails::Routes.resolve("POST", "/items")
    assert_equal :eligible, Sendproof::Rails::Routes.resolve("PATCH", "/items/7")
    assert_equal :ineligible, Sendproof::Rails::Routes.resolve("DELETE", "/items/7")
    assert_nil Sendproof::Rails::Routes.resolve("POST", "/missing")
    assert_nil Sendproof::Rails::Routes.resolve("GET", "/items/7/unknown")
  end
end

class ControllerMacroTest < Minitest::Test
  def test_unmarked_controllers_are_not_previewable
    refute ApplicationController.sendproof_preview?(:anything)
  end

  def test_only_and_except
    assert ItemsController.sendproof_preview?(:create)
    refute ItemsController.sendproof_preview?(:index)
    assert PartialController.sendproof_preview?("shown")
    refute PartialController.sendproof_preview?(:hidden)
  end
end

class EndpointTest < Minitest::Test
  include Rack::Test::Methods

  PREVIEW = { "HTTP_PREFER" => "tx=rollback", "CONTENT_TYPE" => "application/json", "HTTP_X_USER" => "alex" }.freeze

  def app = DummyApp

  def setup
    PROVIDER.sessions.clear
  end

  def json = JSON.parse(last_response.body)

  def preview(path, body = {}, headers = {}, method: :post)
    public_send(method, "/sendproof/_preview#{path}", JSON.generate(body), PREVIEW.merge(headers))
  end

  def assert_unconfirmed(status)
    assert_equal status, last_response.status, last_response.body
    assert_nil last_response["preference-applied"]
  end

  # --- discovery --------------------------------------------------------------------------------

  def test_capabilities_list_the_marked_actions_in_a_stable_order
    get "/sendproof/_api/capabilities", {}, { "HTTP_X_USER" => "alex" }
    assert_equal 200, last_response.status
    operations = json["previewOperations"].map { |o| [o["method"], o["path"]] }
    assert_includes operations, ["POST", "/items"]
    assert_equal operations.sort_by { |method, path| [path, method] }, operations
    assert_equal({ "name" => "alex", "role" => "admin" }, json["identity"])
    assert_equal "test", json["environment"]
    assert_equal "dummy", json["database"]
    assert_equal "DummyApp", json["apiName"], "defaults to the application class"
    assert_equal true, json["observedSend"]
  end

  def test_the_workbench_is_served
    get "/sendproof/"
    assert_includes last_response.body, "Sendproof"
  end

  def test_nothing_is_served_in_an_environment_that_is_not_enabled
    environments = DummyApp.config.sendproof.environments.dup
    DummyApp.config.sendproof.environments = %w[staging]
    get "/sendproof/_api/capabilities"
    assert_equal 404, last_response.status
    preview("/items", { id: "a" })
    assert_equal 404, last_response.status
  ensure
    DummyApp.config.sendproof.environments = environments
  end

  # --- preview through the real router and controllers ------------------------------------------

  def test_preview_runs_the_real_action_and_rolls_back
    preview("/items", { id: "a" })
    assert_equal 200, last_response.status
    assert_equal "tx=rollback", last_response["preference-applied"]
    assert_equal 201, json["status"]
    assert_equal({ "id" => "a" }, json["body"])
    assert_equal [:rollback, :close], PROVIDER.sessions.fetch(0).log
  end

  def test_effects_are_suppressed_and_rails_logs_are_captured_at_info
    preview("/items", { id: "a" })
    assert_equal ["Created item"], json["effects"].map { |effect| effect["description"] }
    messages = json["logs"].map { |log| log["message"] }
    assert_includes messages, "created:a"
    refute_includes messages, "hidden debug line"
  end

  def test_authorization_runs_before_the_action_and_blocks_the_preview
    post "/sendproof/_preview/items", "{}", PREVIEW.except("HTTP_X_USER")
    assert_unconfirmed 401
  end

  def test_unmarked_actions_never_open_a_session
    preview("/items/7", {}, {}, method: :delete)
    assert_unconfirmed 409
    assert_empty PROVIDER.sessions
  end

  def test_unknown_targets_are_not_found
    preview("/nowhere")
    assert_unconfirmed 404
    assert_empty PROVIDER.sessions
  end

  def test_a_client_error_exception_is_a_confirmed_inner_response
    preview("/items/7", {}, {}, method: :patch)
    assert_equal 200, last_response.status
    assert_equal 400, json["status"], "ParameterMissing maps to 400 like ShowExceptions"
    assert_equal true, json["rolledBack"]
  end

  def test_an_unhandled_exception_is_unconfirmed_and_rolled_back
    preview("/items/boom")
    assert_unconfirmed 500
    assert_equal [:rollback, :close], PROVIDER.sessions.fetch(0).log
  end

  def test_preview_neither_persists_the_session_nor_sets_cookies
    preview("/items/7/touch")
    assert_equal 200, json["status"]
    assert_nil last_response["set-cookie"]
    refute_includes last_response.headers.keys.join, "set-cookie"
    get "/sendproof/_api/capabilities"
    assert_nil last_response["set-cookie"]
  end

  def test_the_rewritten_request_is_the_original_endpoint
    preview("/items/7?audit=true", { name: "Renamed" }, {}, method: :patch)
    assert_equal({ "name" => "Renamed" }, json["body"])
  end

  # --- observed send ----------------------------------------------------------------------------

  def test_observed_send_keeps_the_response_and_adds_a_trace_for_marked_actions
    post "/items", JSON.generate({ id: "z" }), { "CONTENT_TYPE" => "application/json", "HTTP_PREFER" => "trace", "HTTP_X_USER" => "alex" }
    assert_equal 201, last_response.status
    assert_equal({ "id" => "z" }, json)
    trace = last_response["x-sendproof-trace"]
    assert_match(/\A\h{32}\z/, trace)
    assert_empty PROVIDER.sessions, "an ordinary send opens no preview transaction"

    get "/sendproof/_api/traces/#{trace}", {}, { "HTTP_X_USER" => "alex" }
    assert_equal 200, last_response.status
    assert_equal [true], json["effects"].map { |effect| effect["delivered"] }
    assert_includes json["logs"].map { |log| log["message"] }, "created:z"

    get "/sendproof/_api/traces/#{trace}", {}, { "HTTP_X_USER" => "sam" }
    assert_equal 404, last_response.status
  end

  def test_unmarked_actions_and_anonymous_callers_get_no_trace
    delete "/items/7", "", { "HTTP_PREFER" => "trace", "HTTP_X_USER" => "alex" }
    assert_equal 204, last_response.status
    assert_nil last_response["x-sendproof-trace"]
  end
end
