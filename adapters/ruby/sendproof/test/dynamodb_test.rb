# frozen_string_literal: true

require_relative "stores_support"
require "net/http"
require "sendproof/dynamodb"

# The DynamoDB hook against DynamoDB Local (docker compose -f tests/conformance/compose.yml up -d --wait dynamodb).
class DynamoDbHookTest < Minitest::Test
  include StoreHelpers

  SECRET = "benchDynamoSecret#{SecureRandom.hex(6)}"

  def setup
    needs(:dynamodb)
    @table = unique
    @client = new_client
    @client.create_table(table_name: @table, billing_mode: "PAY_PER_REQUEST",
                         attribute_definitions: [{ attribute_name: "id", attribute_type: "S" }],
                         key_schema: [{ attribute_name: "id", key_type: "HASH" }])
    @client.put_item(table_name: @table, item: { "id" => "seeded", "status" => "open", "hits" => 3 })
    @store = Sendproof::DynamoDB::Store.new(client: @client, name: "orders")
  end

  def teardown
    @client&.delete_table(table_name: @table)
  end

  def new_client(**options)
    Aws::DynamoDB::Client.new(endpoint: SERVERS[:dynamodb], region: "us-east-1", access_key_id: "benchlocal",
                              secret_access_key: SECRET, **options)
  end

  # What is really stored, read by a client the hook never saw.
  def stored(id) = new_client.get_item(table_name: @table, key: { "id" => id }, consistent_read: true).item

  def touch(id)
    @client.update_item(table_name: @table, key: { "id" => id }, update_expression: "ADD hits :one SET #s = if_not_exists(#s, :new)",
                        expression_attribute_names: { "#s" => "status" }, expression_attribute_values: { ":one" => 1, ":new" => "new" },
                        return_values: "ALL_NEW")
  end

  def test_a_read_in_a_preview_runs_and_is_logged
    recorder = preview { |_| assert_equal "open", @client.get_item(table_name: @table, key: { "id" => "seeded" }).item["status"] }
    assert_nil recorder.blocked
    entry = db_entries(recorder, "GetItem").fetch(0)
    assert_equal @table, entry[:db][:target]
    assert_equal 1, entry[:db][:rowsAffected]
  end

  def test_an_update_item_is_refused_before_it_is_sent
    assert_blocked_in_preview("dynamodb", "UpdateItem") { touch("blocked") }
    assert_nil stored("blocked"), "UpdateItem must not reach DynamoDB"
  end

  def test_put_delete_and_batch_writes_are_refused
    assert_blocked_in_preview("dynamodb", "PutItem") { @client.put_item(table_name: @table, item: { "id" => "x" }) }
    assert_blocked_in_preview("dynamodb", "DeleteItem") { @client.delete_item(table_name: @table, key: { "id" => "seeded" }) }
    assert_blocked_in_preview("dynamodb", "BatchWriteItem") do
      @client.batch_write_item(request_items: { @table => [{ put_request: { item: { "id" => "y" } } }] })
    end
    assert_nil stored("x")
    assert_equal "open", stored("seeded")["status"]
  end

  def test_partiql_select_is_a_read_and_update_is_a_write
    preview { |_| @client.execute_statement(statement: %(SELECT * FROM "#{@table}" WHERE id = ?), parameters: ["seeded"]) }
    recorder = assert_blocked_in_preview("dynamodb", "ExecuteStatement") do
      @client.execute_statement(statement: %(UPDATE "#{@table}" SET status = 'cancelled' WHERE id = ?), parameters: ["seeded"])
    end
    assert_equal "open", stored("seeded")["status"], "The PartiQL UPDATE must not reach DynamoDB"
    assert recorder.blocked
  end

  def test_inline_partiql_literals_are_replaced_in_the_log
    recorder = preview do |_|
      @client.execute_statement(statement: %(SELECT * FROM "#{@table}" WHERE id = 'seeded' AND hits > 2))
    end
    statement = db_entries(recorder, "ExecuteStatement").fetch(0)[:db][:statement]
    assert_equal %(SELECT * FROM "#{@table}" WHERE id = ? AND hits > ?), statement
    refute_includes statement, "seeded"
  end

  def test_sanitize_partiql_keeps_quoted_names_and_escaped_quotes
    sanitize = Sendproof::DynamoDB::Store.method(:sanitize_partiql)
    assert_equal %(UPDATE "t" SET a = ?, "b 1" = ? WHERE id = ?), sanitize.call(%(UPDATE "t" SET a = 12.5, "b 1" = 'it''s' WHERE id = 'x'))
    assert_equal "SELECT t2 FROM x1", sanitize.call("SELECT t2 FROM x1")
  end

  def test_credentials_and_signatures_never_reach_a_capture
    recorder = preview { |_| @client.get_item(table_name: @table, key: { "id" => "seeded" }) }
    json = JSON.generate(captured(recorder).logs)
    refute_includes json, SECRET
    refute_includes json, "AWS4-HMAC-SHA256"
    refute_includes json, "benchlocal"
  end

  def test_observed_send_commits_once_and_traces_the_operation
    recorder = observe { assert_equal 1, touch("sent").attributes["hits"] }
    assert_equal 1, db_entries(recorder, "UpdateItem").length
    assert_equal 1, stored("sent")["hits"]
  end

  def test_writes_outside_a_capture_are_never_blocked
    assert_equal 1, touch("plain").attributes["hits"]
  end

  def test_a_handler_that_swallows_the_error_still_leaves_the_preview_blocked
    recorder = preview do |_|
      begin
        touch("swallowed")
      rescue Sendproof::PreviewWriteBlocked
        nil
      end
    end
    refute_nil recorder.blocked
    assert_nil stored("swallowed")
  end

  def test_the_resource_api_is_covered_because_it_uses_the_hooked_client
    table = Aws::DynamoDB::Resource.new(client: @client).table(@table)
    assert_blocked_in_preview("dynamodb", "PutItem") { table.put_item(item: { "id" => "res" }) }
    assert_nil stored("res")
  end

  def test_a_client_made_with_the_plugin_is_guarded
    guarded = new_client(plugins: [@store.plugin])
    assert_blocked_in_preview("dynamodb", "PutItem") { guarded.put_item(table_name: @table, item: { "id" => "plug" }) }
    assert_nil stored("plug")
  end

  def test_a_client_that_was_never_hooked_is_not_covered
    other = new_client
    recorder = preview { |_| other.put_item(table_name: @table, item: { "id" => "unhooked" }) }
    assert_nil recorder.blocked
    assert_equal "unhooked", stored("unhooked")["id"], "An unhooked client writes through: it is outside the hook"
  end

  def test_hooking_a_client_twice_is_refused
    assert_raises(Sendproof::ConfigurationError) { @store.hook(@client) }
  end

  def test_the_guard_checks_fail_when_the_hook_is_removed
    @store.unhook!
    recorder = preview { |_| touch("unguarded") }
    assert_nil recorder.blocked
    assert_equal 1, stored("unguarded")["hits"]
  end

  def test_discovery_lists_the_store_in_guard_mode
    assert_equal({ system: "dynamodb", name: "orders", mode: :guard }, @store.describe)
  end
end
