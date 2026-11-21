# frozen_string_literal: true

# Loaded before minitest/autorun so the fixture's database cleanup runs after the tests, not before.
ENV["RAILS_ENV"] = "development"
require_relative "../app"
require "minitest/autorun"
require "rack/test"

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
end
