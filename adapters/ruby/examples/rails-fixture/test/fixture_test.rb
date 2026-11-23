# frozen_string_literal: true

# Loaded before minitest/autorun so the fixture's database cleanup runs after the tests, not before.
ENV["RAILS_ENV"] = "development"
require_relative "../app"
require "minitest/autorun"
require "rack/test"
require "json_schemer"

# A fast in-process smoke test of the fixture. The shared HTTP conformance runner
# (node tests/conformance/run.mjs ruby-rails) covers the full protocol over real sockets.
class FixtureTest < Minitest::Test
  include Rack::Test::Methods

  ROLLBACK = { "HTTP_PREFER" => "tx=rollback", "CONTENT_TYPE" => "application/json" }.freeze

  def app = Fixture::Application

  def setup
    Fixture::Item.delete_all
    Fixture::OUTBOX.clear
    clear_cookies
  end

  def json = JSON.parse(last_response.body)

  def sign_in(email = "admin@example.test")
    post "/auth/sign-in", JSON.generate(email: email, password: Fixture::PASSWORD), "CONTENT_TYPE" => "application/json"
    assert_equal 200, last_response.status
  end

  def durable_ids = Thread.new { ActiveRecord::Base.connection_pool.with_connection { Fixture::Item.order(:id).pluck(:id) } }.value

  def test_discovery_advertises_the_fixture_operations_and_cookie_sign_in
    get "/sendproof/_api/capabilities"
    assert_equal 200, last_response.status
    assert_nil json["identity"]
    assert_equal %w[cookie personas], json["authProviders"].map { |p| p["kind"] }
    operations = json["previewOperations"].map { |o| "#{o['method']} #{o['path']}" }
    assert_includes operations, "POST /items/{id}/capture"
    refute_includes operations, "POST /items/{id}/ordinary"
    assert_equal "Sendproof Conformance", Fixture::OPENAPI[:info][:title]
  end

  def test_code_journey_matches_the_original_files_and_arazzo_schema
    get "/sendproof/_api/capabilities"
    entry = json.fetch("journeys").fetch(0)
    assert_equal "code", entry.fetch("source")

    get entry.fetch("arazzoUrl")
    document = json
    assert_equal JSON.parse(File.read(File.expand_path("../journeys/conformance.arazzo.json", __dir__))), document
    schema = File.expand_path("../../../../../tests/Sendproof.Journeys.Tests/Schemas/arazzo-1.1-2026-04-15.schema.json", __dir__)
    draft = JSONSchemer.draft202012
    resolver = ->(uri) { uri == draft.base_uri ? draft.value : draft.ref_resolver.call(uri) }
    errors = JSONSchemer.schema(JSON.parse(File.read(schema)), ref_resolver: resolver).validate(document).to_a
    assert_empty errors

    get entry.fetch("expectationsUrl")
    expected = JSON.parse(File.read(File.expand_path("../journeys/conformance.expect.json", __dir__)))
    assert_equal expected, json
  end

  def test_preview_rolls_back_and_send_persists
    sign_in
    post "/sendproof/_preview/items", JSON.generate(id: "p", name: "Previewed"), ROLLBACK
    assert_equal 200, last_response.status
    assert_equal 201, json["status"]
    assert_equal ["insert"], json["changes"].map { |c| c["operation"] }
    assert_equal ["Created item"], json["effects"].map { |e| e["description"] }
    assert_empty durable_ids
    assert_empty Fixture::OUTBOX
    assert_includes JSON.generate(json), "[REDACTED]"
    refute_includes JSON.generate(json), "fixture-secret-value"

    post "/items", JSON.generate(id: "p", name: "Sent"), "CONTENT_TYPE" => "application/json"
    assert_equal 201, last_response.status
    assert_equal ["p"], durable_ids
    assert_equal 1, Fixture::OUTBOX.length
  end

  def test_a_viewer_cannot_write_and_an_anonymous_caller_is_refused
    post "/items", "{}", "CONTENT_TYPE" => "application/json"
    assert_equal 401, last_response.status
    sign_in("viewer@example.test")
    post "/sendproof/_preview/items", JSON.generate(id: "v", name: "x"), ROLLBACK
    assert_equal 403, last_response.status
    assert_nil last_response["preference-applied"]
  end

  def test_capture_overflows_every_limit_and_still_rolls_back
    sign_in
    post "/sendproof/_preview/items/bulk/capture", "", ROLLBACK
    assert_equal true, json["changesTruncated"]
    assert_equal true, json["effectsTruncated"]
    assert_equal true, json["logsTruncated"]
    assert_empty durable_ids
  end

  def test_a_raised_failure_is_unconfirmed
    sign_in
    post "/sendproof/_preview/items/x/fail?mode=raise", "", ROLLBACK
    assert_equal 500, last_response.status
    assert_nil last_response["preference-applied"]
    assert_empty durable_ids
  end

  def test_failed_session_step_is_undone_and_transaction_control_closes_the_session
    sign_in
    post "/sendproof/_api/sessions"
    assert_equal 201, last_response.status, last_response.body
    session = json.fetch("id")
    headers = ROLLBACK.merge("HTTP_SENDPROOF_SESSION" => session)
    path = "/sendproof/_preview/items/x"

    post "#{path}/fail?mode=raise", "{}", headers
    assert_equal 500, last_response.status, last_response.body
    get path, {}, headers
    assert_equal 200, last_response.status, last_response.body
    assert_equal 404, json.fetch("status")
    assert_equal 1, json.dig("session", "step")

    post "#{path}/commit", JSON.generate(name: "Escaped"), headers
    assert_equal 500, last_response.status, last_response.body
    get path, {}, headers
    assert_equal 404, last_response.status, last_response.body
    assert_equal "session_not_found", json.fetch("code")
    assert_empty durable_ids
  ensure
    delete "/sendproof/_api/sessions/#{session}" if session
  end

  def test_discovery_names_the_binding_and_the_sql_system
    get "/sendproof/_api/capabilities"
    assert_equal({ "language" => "ruby", "framework" => "Rails" }, json["binding"])
    assert_equal({ "name" => "fixture", "system" => "sqlite" }, json["database"])
    assert_nil json["dataStores"], "No store is hooked without its variables"
  end

  # The shared secret-columns rule: password_hash is [REDACTED] and the password appears nowhere.
  def test_an_account_preview_hides_the_password_hash_everywhere
    sign_in
    post "/sendproof/_preview/accounts", JSON.generate(id: "a", email: "a@example.test", password: "fixture-password-value"), ROLLBACK
    assert_equal 200, last_response.status, last_response.body
    change = json["changes"].find { |entry| entry["table"] == "accounts" }
    assert_equal "[REDACTED]", change["after"]["password_hash"]
    refute_includes last_response.body, "fixture-password-value"
    assert_equal 0, Fixture::Account.count
  end

  # The shared raw-commit rule: the handler's COMMIT is refused, the Preview answers 500 and nothing persists.
  def test_a_handler_commit_fails_the_preview_and_persists_nothing
    sign_in
    post "/sendproof/_preview/items/c/commit", JSON.generate(name: "Committed"), ROLLBACK
    assert_equal 500, last_response.status
    assert_nil last_response["preference-applied"]
    assert_empty durable_ids
  end
end
