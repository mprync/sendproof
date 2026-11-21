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
  # inner transaction completes. Their side effects must go through Sendproof.record_effect to be suppressed.
  def test_after_commit_callbacks_still_run_so_their_effects_can_be_recorded
    preview { Item.create!(id: "a", name: "Alpha") }
    assert_equal ["a"], Item::COMMITS
    assert_empty durable_items
  end

  def test_a_handler_exception_still_rolls_back
    assert_raises(RuntimeError) { preview { Item.create!(id: "a", name: "Alpha"); raise "handler failed" } }
    assert_empty durable_items
    assert_nil Sendproof::ActiveRecord::Tracker.current
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
    session, = preview { (Sendproof::Limits::CHANGES + 3).times { |n| Item.create!(id: "i#{n}", name: "n") } }
    assert_equal Sendproof::Limits::CHANGES, session.changes.length
    assert session.changes_truncated?
  end

  def test_a_failed_begin_releases_everything
    broken = Class.new { def lease_connection = raise("no connection") }
    provider = Sendproof::ActiveRecord::Provider.new(connection_classes: [ActiveRecord::Base, broken.new])
    assert_raises(RuntimeError) { provider.begin_preview(Context.new) }
    assert_nil Sendproof::ActiveRecord::Tracker.current
    assert_equal 0, Item.lease_connection.open_transactions, "the transaction opened before the failure was rolled back"
  end

  def test_the_database_label_never_exposes_a_path_or_host
    assert_equal "test", Sendproof::ActiveRecord::Provider.new.database unless MYSQL
    assert_equal "inventory", Sendproof::ActiveRecord::Provider.new(database: "inventory").database
  end

  def test_nothing_is_tracked_outside_a_capture
    Item.create!(id: "a", name: "Alpha")
    assert_nil Sendproof::ActiveRecord::Tracker.current
  end
end

class SqlCaptureTest < Minitest::Test
  include ProviderHelpers

  # A bound parameter, or on a database without prepared statements (MySQL) an inlined literal.
  def probe(name, value)
    return Item.lease_connection.select_all("SELECT #{Item.lease_connection.quote(value)} AS #{name}", "Probe") if MYSQL

    attribute = ActiveRecord::Relation::QueryAttribute.new(name, value, ActiveRecord::Type::String.new)
    Item.lease_connection.select_all("SELECT ? AS #{name}", "Probe", [attribute])
  end

  # A real Active Record query with a bind named +name+: bound on SQLite, inlined as a literal by an adapter
  # without prepared statements (Trilogy, or any connection inside +unprepared_statement+).
  def arel_probe(name, value, alias_name = name)
    attribute = ActiveRecord::Relation::QueryAttribute.new(name, value, ActiveRecord::Type::String.new)
    manager = Arel::SelectManager.new
    manager.project(Arel::Nodes::As.new(Arel::Nodes::BindParam.new(attribute), Arel.sql(alias_name)))
    Item.lease_connection.select_all(manager, "Probe")
  end

  def unprepared(&) = Item.lease_connection.unprepared_statement(&)

  def test_a_value_inlined_without_prepared_statements_is_reported_as_a_redacted_parameter
    _, snapshot = preview { unprepared { arel_probe("fixture_secret", "fixture-secret-value") } }
    refute_includes JSON.generate(snapshot.logs), "fixture-secret-value"
    parameter = snapshot.logs.flat_map { |log| log.dig(:sql, :parameters) || [] }.find { |p| p[:name] == "fixture_secret" }
    assert_equal "[REDACTED]", parameter&.dig(:value), "The inlined bind is reported by name, never by value"
  end

  def test_a_secret_bind_inlined_under_a_harmless_name_is_masked_in_the_text
    _, snapshot = preview { unprepared { arel_probe("api_token", "zq-77-opaque", "shown") } }
    refute_includes JSON.generate(snapshot.logs), "zq-77-opaque"
  end

  def test_an_inlined_value_is_shown_when_values_are_shown_and_nothing_looks_secret
    _, snapshot = preview { unprepared { arel_probe("label", "plain-label") } }
    parameter = snapshot.logs.flat_map { |log| log.dig(:sql, :parameters) || [] }.find { |p| p[:name] == "label" }
    assert_equal "plain-label", parameter&.dig(:value)
  end

  def test_sql_is_logged_with_parameters_and_timing
    skip "MySQL inlines values instead of binding parameters" if MYSQL
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
    _, snapshot = preview { arel_probe("fixture_secret", "fixture-secret-value") }
    refute_includes JSON.generate(snapshot.logs), "fixture-secret-value"
    parameter = snapshot.logs.flat_map { |log| log.dig(:sql, :parameters) || [] }.find { |p| p[:name] == "fixture_secret" }
    assert_equal "[REDACTED]", parameter[:value]
  end

  def test_a_statement_that_names_a_secret_is_shown_without_its_literals
    _, snapshot = preview { probe("fixture_secret", "fixture-secret-value") }
    text = snapshot.logs.map { |log| log.dig(:sql, :text) }.compact.find { |sql| sql.include?("fixture_secret") }
    refute_includes text, "fixture-secret-value"
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
    recorder = Sendproof::Recorder.new(rollback: true)
    Sendproof::Capture.with(recorder) { Item.count }
    assert_operator recorder.timing(Sendproof::Clock::Request.new, 0.0)[:queryCount], :>=, 1
  end
end

class ObservationTest < Minitest::Test
  include ProviderHelpers

  def observe
    recorder = Sendproof::Recorder.new(rollback: false)
    observation = Sendproof::ActiveRecord::Provider.new.begin_observation(Context.new)
    Sendproof::Capture.with(recorder) { yield }
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
    assert_nil Sendproof::ActiveRecord::Tracker.current
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

  # --- the raw-commit rule ----------------------------------------------------------------------

  def test_a_raw_commit_is_refused_before_it_reaches_the_database_and_records_a_fault
    refused = nil
    session, = preview do
      Item.create!(id: "a", name: "Alpha")
      begin
        Item.lease_connection.execute("COMMIT")
      rescue Sendproof::PreviewTransactionControl => error
        refused = error
      end
    end
    refute_nil refused, "The COMMIT must be refused"
    assert_kind_of Sendproof::PreviewTransactionControl, recorder.fault
    assert_empty durable_items, "Nothing may have been committed"
    assert_equal ["insert"], session.changes.map { |c| c[:operation] }
  end

  def test_other_transaction_control_statements_are_refused_too
    ["END", "ROLLBACK", "BEGIN", "SET autocommit = 1", "/* x */ commit", "select 1; COMMIT"].each do |sql|
      preview { assert_raises(Sendproof::PreviewTransactionControl, sql) { Item.lease_connection.execute(sql) } }
    end
  end

  def test_savepoints_and_ordinary_statements_stay_allowed
    session, = preview do
      Item.transaction(requires_new: true) { Item.create!(id: "a", name: "Alpha") }
      Item.lease_connection.execute("SAVEPOINT mine")
      Item.lease_connection.execute("ROLLBACK TO SAVEPOINT mine")
      Item.lease_connection.execute("RELEASE SAVEPOINT mine")
    end
    assert_nil recorder.fault
    assert_equal ["insert"], session.changes.map { |c| c[:operation] }
  end

  def test_a_raw_commit_outside_a_preview_is_not_refused
    # An observed send and an ordinary request run unguarded.
    observe { Item.create!(id: "a", name: "Alpha") }
    assert_equal ["a"], durable_items
  end

  # --- discovery --------------------------------------------------------------------------------

  def test_the_provider_names_its_sql_system
    assert_equal(MYSQL ? "mysql" : "sqlite", Sendproof::ActiveRecord::Provider.new.database_system)
    assert_equal "mariadb", Sendproof::ActiveRecord::Provider.new(system: "mariadb").database_system
  end

  # --- MySQL turn-taking --------------------------------------------------------------------------

  def test_serialized_previews_never_overlap_and_all_complete
    provider = Sendproof::ActiveRecord::Provider.new(serialize_previews: true)
    running = 0
    overlap = 0
    guard = Mutex.new
    threads = Array.new(6) do |n|
      Thread.new do
        # The turn is taken before the connection is leased, so waiting Previews hold none.
        preview(provider) do
          guard.synchronize { running += 1; overlap = [overlap, running].max }
          Item.create!(id: "turn-#{n}", name: "Turn")
          sleep 0.02
          guard.synchronize { running -= 1 }
        end
      ensure
        ActiveRecord::Base.connection_pool.release_connection
      end
    end
    threads.each(&:join)
    assert_equal 1, overlap, "Serialized previews must take turns"
    assert_empty durable_items
  end

  # Set BENCH_DATABASE=mysql (bin/test-mysql) to run this against a server. On MySQL, InnoDB aborts all but
  # one of several Previews inserting one new key with a deadlock (1213) unless they take turns.
  def test_concurrent_previews_inserting_one_key_all_complete
    skip "Set BENCH_DATABASE=mysql to run this against a MySQL server." unless MYSQL
    provider = Sendproof::ActiveRecord::Provider.new
    start = Queue.new
    results = Array.new(8) do
      Thread.new do
        start.pop # released together, so every Preview reaches its insert at once
        session, = preview(provider) do
          Item.create!(id: "shared", name: "Shared")
          sleep 0.05 # let the others reach their insert and wait on this row
        end
        session.changes.map { |change| [change[:operation], change[:key]] }
      ensure
        ActiveRecord::Base.connection_pool.release_connection
      end
    end
    results.length.times { start << true }
    results = results.map(&:value)
    assert(results.all? { |changes| changes == [["insert", { "id" => "shared" }]] }, results.inspect)
    assert_empty durable_items
  end

  def test_a_failed_begin_hands_the_turn_back
    provider = Sendproof::ActiveRecord::Provider.new(serialize_previews: true)
    broken = Class.new { def self.lease_connection = raise("no connection") }
    provider.instance_variable_set(:@connection_classes, [broken])
    assert_raises(RuntimeError) { provider.begin_preview(Context.new) }
    Timeout.timeout(2) { preview(Sendproof::ActiveRecord::Provider.new(serialize_previews: true)) { Item.create!(id: "a", name: "A") } }
    provider.instance_variable_set(:@connection_classes, [ActiveRecord::Base])
    Timeout.timeout(2) { preview(provider) { Item.create!(id: "b", name: "B") } }
  end
end
