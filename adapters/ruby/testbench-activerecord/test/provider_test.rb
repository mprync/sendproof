# frozen_string_literal: true

require_relative "test_helper"

class ProviderTest < Minitest::Test
  include ProviderHelpers

  def test_insert_is_visible_to_the_handler_and_gone_afterwards
    seen = nil
    session, = preview do
      Item.create!(id: "a", name: "Alpha")
      seen = Item.find("a").name
    end
    assert_equal "Alpha", seen
    assert_empty durable_items
    assert_equal [{ operation: "insert", table: "items", key: { "id" => "a" }, before: nil }],
                 session.changes.map { |c| c.slice(:operation, :table, :key, :before) }
    assert_equal "Alpha", session.changes.first[:after]["name"]
  end

  def test_update_reports_before_and_after_values
    Item.create!(id: "a", name: "Initial")
    session, = preview { Item.find("a").update!(name: "Temporary") }
    change = session.changes.fetch(0)
    assert_equal "update", change[:operation]
    assert_equal "Initial", change[:before]["name"]
    assert_equal "Temporary", change[:after]["name"]
    assert_equal "Initial", Item.find("a").name
  end

  def test_an_update_that_changes_nothing_is_not_a_change
    Item.create!(id: "a", name: "Same")
    session, = preview { Item.find("a").update!(name: "Same") }
    assert_empty session.changes
  end

  def test_destroy_reports_the_deleted_row
    Item.create!(id: "a", name: "Alpha")
    session, = preview { Item.find("a").destroy! }
    change = session.changes.fetch(0)
    assert_equal "delete", change[:operation]
    assert_equal "Alpha", change[:before]["name"]
    assert_nil change[:after]
    assert_equal ["a"], durable_items
  end

  def test_two_saves_of_the_same_row_are_two_changes
    session, = preview do
      item = Item.create!(id: "a", name: "One")
      item.update!(name: "Two")
    end
    assert_equal %w[insert update], session.changes.map { |c| c[:operation] }
  end

  def test_composite_primary_keys_are_reported_whole
    session, = preview { Membership.create!(org_id: 1, user_id: 2, role: "admin") }
    assert_equal({ "org_id" => 1, "user_id" => 2 }, session.changes.first[:key])
    assert_equal 0, Membership.count
  end

  def test_a_nested_transaction_rolled_back_by_the_handler_leaves_no_change
    session, = preview do
      Item.create!(id: "kept", name: "Kept")
      Item.transaction(requires_new: true) do
        Item.create!(id: "dropped", name: "Dropped")
        raise ActiveRecord::Rollback
      end
    end
    assert_equal ["kept"], session.changes.map { |c| c[:key]["id"] }
    assert_empty durable_items
  end

  def test_handler_transactions_cannot_commit_the_preview
    preview { Item.transaction { Item.create!(id: "a", name: "Alpha") } }
    assert_empty durable_items
  end

  # Rails treats a non-joinable parent like transactional tests do: after_commit callbacks run when each
  # inner transaction completes. Their side effects must go through TestBench.record_effect to be suppressed.
  def test_after_commit_callbacks_still_run_so_their_effects_can_be_recorded
    preview { Item.create!(id: "a", name: "Alpha") }
    assert_equal ["a"], Item::COMMITS
    assert_empty durable_items
  end

  def test_a_handler_exception_still_rolls_back
    assert_raises(RuntimeError) { preview { Item.create!(id: "a", name: "Alpha"); raise "handler failed" } }
    assert_empty durable_items
    assert_nil TestBench::ActiveRecord::Tracker.current
  end

  def test_the_connection_is_usable_afterwards
    preview { Item.create!(id: "a", name: "Alpha") }
    Item.create!(id: "b", name: "Beta")
    assert_equal ["b"], durable_items
    assert_equal 0, Item.connection.open_transactions
  end

  def test_writes_that_skip_callbacks_are_rolled_back_but_flagged
    Item.create!(id: "a", name: "Initial")
    session, snapshot = preview { Item.update_all(name: "Bulk") }
    assert_empty session.changes
    assert_equal "Initial", Item.find("a").name
    warning = snapshot.logs.find { |log| log[:level] == "Warning" }
    assert_includes warning[:message], "bypassed model callbacks"
  end

  def test_a_commit_inside_the_handler_is_detected_and_never_confirmed
    error = assert_raises(RuntimeError) do
      preview do
        Item.create!(id: "a", name: "Alpha")
        Item.lease_connection.commit_transaction
      end
    end
    assert_match(/not rolled back/, error.message)
  ensure
    Item.delete_all
  end

  def test_changes_are_capped_and_flagged
    session, = preview { (TestBench::Limits::CHANGES + 3).times { |n| Item.create!(id: "i#{n}", name: "n") } }
    assert_equal TestBench::Limits::CHANGES, session.changes.length
    assert session.changes_truncated?
  end

  def test_a_failed_begin_releases_everything
    broken = Class.new { def lease_connection = raise("no connection") }
    provider = TestBench::ActiveRecord::Provider.new(connection_classes: [ActiveRecord::Base, broken.new])
    assert_raises(RuntimeError) { provider.begin_preview(Context.new) }
    assert_nil TestBench::ActiveRecord::Tracker.current
    assert_equal 0, Item.lease_connection.open_transactions, "the transaction opened before the failure was rolled back"
  end

  def test_the_database_label_never_exposes_a_path_or_host
    assert_equal "test", TestBench::ActiveRecord::Provider.new.database
    assert_equal "inventory", TestBench::ActiveRecord::Provider.new(database: "inventory").database
  end

  def test_nothing_is_tracked_outside_a_capture
    Item.create!(id: "a", name: "Alpha")
    assert_nil TestBench::ActiveRecord::Tracker.current
  end
end

class SqlCaptureTest < Minitest::Test
  include ProviderHelpers

  def probe(name, value)
    attribute = ActiveRecord::Relation::QueryAttribute.new(name, value, ActiveRecord::Type::String.new)
    Item.lease_connection.select_all("SELECT ? AS #{name}", "Probe", [attribute])
  end

  def test_sql_is_logged_with_parameters_and_timing
    _, snapshot = preview { Item.create!(id: "a", name: "Alpha") }
    insert = snapshot.logs.find { |log| log[:sql] && log[:sql][:text].start_with?("INSERT") }
    assert_equal "Sql", insert[:level]
    assert_equal %w[id name], insert[:sql][:parameters].map { |p| p[:name] }.first(2)
    assert_equal ["a", "Alpha"], insert[:sql][:parameters].first(2).map { |p| p[:value] }
    assert_operator insert[:elapsedMs], :>=, 0
  end

  def test_schema_and_transaction_statements_are_not_logged
    _, snapshot = preview { Item.create!(id: "a", name: "Alpha") }
    refute(snapshot.logs.any? { |log| log[:message] =~ /SAVEPOINT|BEGIN|COMMIT|PRAGMA/i })
  end

  def test_secret_named_parameters_are_redacted_even_when_values_are_shown
    _, snapshot = preview { probe("fixture_secret", "fixture-secret-value") }
    refute_includes JSON.generate(snapshot.logs), "fixture-secret-value"
    parameter = snapshot.logs.flat_map { |log| log.dig(:sql, :parameters) || [] }.find { |p| p[:name] == "fixture_secret" }
    assert_equal "[REDACTED]", parameter[:value]
  end

  def test_a_secret_column_hides_every_value_in_its_statement
    Item.create!(id: "a", name: "Alpha")
    _, snapshot = preview { Item.find("a").update!(name: "Private name", password_hash: "digest") }
    update = snapshot.logs.find { |log| log[:sql] && log[:sql][:text].start_with?("UPDATE") }
    assert(update[:sql][:parameters].all? { |p| p[:value] == "[REDACTED]" })
    refute_includes JSON.generate(snapshot.logs), "Private name"
  end

  def test_values_are_hidden_unless_enabled
    _, snapshot = preview(include_values: false) { Item.create!(id: "a", name: "Alpha") }
    values = snapshot.logs.flat_map { |log| log.dig(:sql, :parameters) || [] }.map { |p| p[:value] }
    assert(values.all? { |value| value == "[REDACTED]" })
  end

  def test_queries_are_counted_for_timing
    recorder = TestBench::Recorder.new(rollback: true)
    TestBench::Capture.with(recorder) { Item.count }
    assert_operator recorder.timing(TestBench::Clock::Request.new, 0.0)[:queryCount], :>=, 1
  end
end

class ObservationTest < Minitest::Test
  include ProviderHelpers

  def observe
    recorder = TestBench::Recorder.new(rollback: false)
    observation = TestBench::ActiveRecord::Provider.new.begin_observation(Context.new)
    TestBench::Capture.with(recorder) { yield }
    observation
  ensure
    observation&.close
  end

  def test_an_observed_send_commits_and_records_the_change
    observation = observe { Item.create!(id: "a", name: "Alpha") }
    assert_equal ["a"], durable_items
    assert_equal ["insert"], observation.changes.map { |c| c[:operation] }
    assert_equal ["a"], Item::COMMITS
  end

  def test_a_change_rolled_back_by_the_handler_is_not_reported
    observation = observe do
      Item.transaction(requires_new: true) do
        Item.create!(id: "gone", name: "Gone")
        raise ActiveRecord::Rollback
      end
      Item.create!(id: "kept", name: "Kept")
    end
    assert_equal ["kept"], observation.changes.map { |c| c[:key]["id"] }
    assert_equal ["kept"], durable_items
  end

  def test_closing_stops_tracking
    observe { Item.create!(id: "a", name: "Alpha") }
    assert_nil TestBench::ActiveRecord::Tracker.current
  end

  def test_change_snapshots_redact_secret_columns_and_filter_attributes
    Item.create!(id: "a", name: "Alpha", password_hash: "old-digest")
    session, = preview do
      Item.find("a").update!(password_hash: "new-digest")
      Item.create!(id: "b", name: "Beta", password_hash: "inserted-digest")
    end
    update, insert = session.changes
    assert_equal "[REDACTED]", update[:before]["password_hash"]
    assert_equal "[REDACTED]", update[:after]["password_hash"]
    assert_equal "[REDACTED]", insert[:after]["password_hash"]
    refute_match(/digest/, JSON.generate(session.changes))

    Item.filter_attributes = [:name]
    session, = preview { Item.create!(id: "c", name: "Filtered") }
    assert_equal "[REDACTED]", session.changes.first[:after]["name"]
  ensure
    Item.filter_attributes = nil
  end
end
