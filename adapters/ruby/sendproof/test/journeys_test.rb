# frozen_string_literal: true

require_relative "test_helper"
require "stringio"
require "logger"

class JourneysTest < Minitest::Test
  OPENAPI = {
    openapi: "3.1.0",
    paths: { "/items" => { post: { operationId: "createItem" } }, "/items/{id}" => { "$ref" => "#/components/pathItems/item" } },
    components: { pathItems: { item: { get: { operationId: "readItem" } } } }
  }.freeze

  def test_startup_reports_invalid_operations_inputs_and_step_outputs
    config = build_config(environment: "development", environments: %w[development])
    config.code_journeys :items, name: "Items" do
      journey :createAndRead, name: "Create and read an item" do
        step :create, :unknownOperation do
          body({ id: "$inputs.unknown", name: "$steps.read.outputs.name" })
          output :id, "$response.body#/id"
        end
        step :read, :readItem do
          parameter :id, location: :path, value: "$steps.create.outputs.unknown"
        end
      end
    end

    error = assert_raises(Sendproof::ConfigurationError) { rack_app(config) }
    assert_includes error.message, 'createAndRead: Step create: unknown operationId "unknownOperation"'
    assert_includes error.message, 'Step create: unknown input "unknown"'
    assert_includes error.message, 'Step create: "read" is not an earlier step'
    assert_includes error.message, 'Step read: step "create" has no output "unknown"'
  end

  def test_startup_skips_invalid_workflows_outside_development
    log = StringIO.new
    config = build_config(logger: Logger.new(log))
    config.code_journeys :items, name: "Items" do
      journey :invalid, name: "Unknown operation" do
        step :create, :unknownOperation
      end
      journey :valid, name: "Create an item" do
        step :create, :createItem
      end
    end

    client = rack_app(config)
    entry = JSON.parse(client.get("/sendproof/_api/capabilities").body).fetch("journeys").first
    assert_equal "code", entry.fetch("source")
    workflows = JSON.parse(client.get(entry.fetch("arazzoUrl")).body).fetch("workflows")
    assert_equal ["valid"], workflows.map { |flow| flow.fetch("workflowId") }
    companion = JSON.parse(client.get(entry.fetch("expectationsUrl")).body)
    assert_equal({ "valid" => { "steps" => {} } }, companion.fetch("journeys"))
    assert_includes log.string, 'Sendproof skipped a journey: invalid: Step create: unknown operationId "unknownOperation"'
  end

  def test_serves_code_and_file_journeys_with_their_expectations
    config = build_config
    fixture = File.expand_path("../../examples/rails-fixture/journeys/conformance.arazzo.json", __dir__)
    config.journey fixture
    provider = CoreHelpers::FakeProvider.new
    provider.define_singleton_method(:database_system) { "sqlite" }
    config.use provider
    config.code_journeys :items, name: "Items" do
      journey :checkWrites, name: "Check writes" do
        group "Inventory"
        run_as "operator@example.test"
        email = input :email, type: :string, format: :email, required: true
        item_id = nil
        step :create, :createItem do
          item_id = output :id, "$response.body#/id"
          expect_writes do
            sql :items, :insert, values: { id: item_id, created_at: any("date-time") }
            mongo :inventory, :update, key: { item: item_id }, values: { status: changed("draft", "ready") }
            redis "item:{#{item_id}}", :set
            email to: email, subject: pattern("^Item created")
          end
          approve_difference id: "AD-1", target: { store: "sqlite", table: "items", field: "name" },
                             expected: nil, actual: "Other", reason: "Fixture data", approved_by: "reviewer@example.test",
                             approved_on: "2026-01-01", expires: "2026-12-31"
        end
        step :read, :readItem do
          run_as "reader@example.test"
          parameter :id, location: :path, value: item_id
          expect_writes { nothing }
        end
        output :item, item_id
      end
    end

    client = rack_app(config)
    entries = JSON.parse(client.get("/sendproof/_api/capabilities").body).fetch("journeys")
    assert_equal %w[file code], entries.map { |entry| entry.fetch("source") }
    code = entries.last
    workflow = JSON.parse(client.get(code.fetch("arazzoUrl")).body).fetch("workflows").first
    assert_equal ["email"], workflow.dig("inputs", "required")
    assert_equal "$steps.create.outputs.id", workflow.dig("outputs", "item")
    assert_equal "$steps.create.outputs.id", workflow.dig("steps", 1, "parameters", 0, "value")

    companion = JSON.parse(client.get(code.fetch("expectationsUrl")).body)
    journey = companion.dig("journeys", "checkWrites")
    assert_equal ["Inventory", "operator@example.test", true], journey.values_at("group", "runAs", "sendOnly")
    assert_includes journey.fetch("sendOnlyReason"), "writes to redis"
    assert_equal [
      { "store" => "sqlite", "table" => "items", "op" => "insert", "values" => { "id" => "$steps.create.outputs.id", "created_at" => { "type" => "date-time" } } },
      { "store" => "mongodb", "collection" => "inventory", "op" => "update", "key" => { "item" => "$steps.create.outputs.id" },
        "values" => { "status" => { "from" => "draft", "to" => "ready" } } },
      { "store" => "redis", "key" => "item:{$steps.create.outputs.id}", "op" => "SET" }
    ], journey.dig("steps", "create", "writes")
    assert_equal [{ "kind" => "email", "to" => "$inputs.email", "subject" => { "pattern" => "^Item created" } }],
                 journey.dig("steps", "create", "effects")
    assert_equal({ "persona" => "reader@example.test", "writes" => [], "effects" => [], "unlisted" => "fail" },
                 journey.dig("steps", "read"))
    assert_equal ["AD-1", "checkWrites", "create", "reviewer@example.test", nil, "Other"],
                 companion.fetch("approvedDifferences").first.values_at("id", "journey", "step", "approvedBy", "expected", "actual")
  end

  private

  def rack_app(config)
    api = lambda do |env|
      return [404, {}, []] unless env["PATH_INFO"] == "/openapi.json"

      Sendproof::Protocol.json(200, OPENAPI)
    end
    Rack::MockRequest.new(Sendproof::Middleware.new(api, config))
  end

  include CoreHelpers
end
