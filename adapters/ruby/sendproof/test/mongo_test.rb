# frozen_string_literal: true

require_relative "stores_support"
require "sendproof/mongo"

# The MongoDB engine and plain-driver store against the compose replica set
# (docker compose -f tests/conformance/compose.yml up -d --wait mongodb).
# Lets one test stand in for a driver that swallows an exception raised from a command subscriber.
Sendproof::Mongo::Subscriber.prepend(Module.new do
  def started(event)
    super
  rescue Sendproof::PreviewWriteBlocked
    raise unless Thread.current[:swallow_refusals]
  end
end)

class MongoHookTest < Minitest::Test
  include StoreHelpers
  include Rack::Test::Methods

  SEEDED = { "_id" => "seeded", "name" => "Seeded", "profile" => { "city" => "Leeds" }, "password_hash" => "hashed:seeded-secret" }.freeze

  def setup
    needs(:mongodb)
    ::Mongo::Logger.logger.level = Logger::WARN
    @database = unique
    @url = "#{SERVERS[:mongodb].sub(%r{/\?}, "/#{@database}?")}"
    @raw = new_client
    @store = Sendproof::Mongo::Store.new(@raw, name: "catalog")
    @client = @store.client
    @others = []
    # An independent client the store never saw: what is really stored.
    @reader = ::Mongo::Client.new(@url, monitoring: false, server_selection_timeout: 3)
    @reader[:documents].insert_one(SEEDED)
  end

  def teardown
    @store&.unhook!
    @reader&.database&.drop
    [@reader, @raw, *@others].compact.each(&:close)
  end

  def new_client(**options)
    ::Mongo::Client.new(@url, server_selection_timeout: 3, **options).tap { |client| (@others ||= []) << client }
  end

  def stored(filter = {}) = @reader[:documents].find(filter).to_a

  def change(snapshot, operation) = snapshot.changes.find { |entry| entry[:operation] == operation }

  # --- Preview mode: rollback and changes -------------------------------------------------------

  def test_a_preview_rolls_back_and_reports_nested_redacted_changes
    recorder = preview([@store]) do |_|
      @client[:documents].insert_one({ _id: "preview-doc", name: "Draft", profile: { city: "York" }, password_hash: "hashed:mongo-secret-value" })
      @client[:documents].update_one({ _id: "seeded" }, { "$set" => { name: "Renamed", "profile.city" => "Hull" } })
    end
    snapshot = captured(recorder)
    assert_nil recorder.blocked
    assert_nil recorder.fault
    assert_empty stored(_id: "preview-doc"), "An independent read must not find the previewed insert"
    assert_equal %w[Seeded Leeds], [stored(_id: "seeded").first["name"], stored(_id: "seeded").first.dig("profile", "city")]

    insert = change(snapshot, "insert")
    assert_equal({ "_id" => "preview-doc" }, insert[:key])
    assert_equal "mongodb", insert[:store]
    assert_equal "documents", insert[:table]
    assert_equal @database, insert[:namespace]
    assert_nil insert[:before]
    assert_equal({ "city" => "York" }, insert[:after]["profile"], "Document snapshots keep their nesting")
    assert_equal "[REDACTED]", insert[:after]["password_hash"]

    update = change(snapshot, "update")
    assert_equal %w[Seeded Renamed], [update[:before]["name"], update[:after]["name"]]
    assert_equal %w[Leeds Hull], [update[:before].dig("profile", "city"), update[:after].dig("profile", "city")]
    refute_includes JSON.generate(snapshot.changes), "mongo-secret-value"
    refute_includes JSON.generate(snapshot.changes), "seeded-secret"
  end

  def test_upserts_and_replacements_are_labelled
    recorder = preview([@store]) do |_|
      @client[:documents].update_one({ _id: "upserted" }, { "$set" => { name: "New" } }, upsert: true)
      @client[:documents].replace_one({ _id: "seeded" }, { name: "Replaced" })
    end
    snapshot = captured(recorder)
    assert_equal "upsert", change(snapshot, "insert")[:via]
    assert_equal "replace", change(snapshot, "update")[:via]
    assert_empty stored(_id: "upserted")
  end

  def test_delete_and_find_and_modify_are_changes
    recorder = preview([@store]) do |_|
      @client[:documents].delete_one(_id: "seeded")
      @client[:documents].find_one_and_update({ _id: "absent" }, { "$set" => { a: 1 } }, upsert: true)
    end
    snapshot = captured(recorder)
    assert_equal "seeded", change(snapshot, "delete")[:key]["_id"]
    assert_nil change(snapshot, "delete")[:after]
    assert_equal 1, stored(_id: "seeded").length
  end

  def test_every_command_is_a_db_entry_without_values
    recorder = preview([@store]) do |_|
      @client[:documents].insert_one({ _id: "log", name: "Secretive" })
      @client[:documents].find(_id: "log").to_a
    end
    entries = db_entries(recorder)
    insert = entries.find { |entry| entry[:db][:operation] == "insert" }
    assert_equal "documents", insert[:db][:target]
    assert_equal @database, insert[:db][:namespace]
    assert_equal %({"insert":"documents","ordered":"?","documents":[{"_id":"?","name":"?"}]}), insert[:db][:statement]
    refute_includes JSON.generate(captured(recorder).logs), "Secretive"
    refute(entries.any? { |entry| %w[hello isMaster ping abortTransaction].include?(entry[:db][:operation]) },
           "Engine and session commands are never logged")
  end

  # --- refusals before sending ------------------------------------------------------------------

  def test_dollar_out_is_blocked_before_sending_with_its_reason
    recorder = assert_blocked_in_preview("mongodb", "aggregate", [@store]) do
      @client[:documents].aggregate([{ "$match" => {} }, { "$out" => "documents_archive" }]).to_a
    end
    assert_equal "Preview unavailable: MongoDB can't run $out inside a transaction", recorder.blocked.detail
    assert_empty @reader[:documents_archive].find.to_a
  end

  def test_a_merge_stage_hidden_in_a_sub_pipeline_is_found
    assert_blocked_in_preview("mongodb", "aggregate", [@store]) do
      @client[:documents].aggregate([{ "$facet" => { "a" => [{ "$lookup" => { "from" => "x", "pipeline" => [{ "$merge" => "y" }], "as" => "z" } }] } }]).to_a
    end
  end

  def test_an_explicit_create_and_other_unsupported_commands_are_blocked
    assert_blocked_in_preview("mongodb", "create", [@store]) { @client.database.command(create: "made") }
    assert_blocked_in_preview("mongodb", "count", [@store]) { @client[:documents].estimated_document_count }
    assert_blocked_in_preview("mongodb", "drop", [@store]) { @client[:documents].drop }
    assert_equal 1, stored.length
    assert_empty @reader.database.collection_names.grep(/made/)
  end

  def test_a_write_sent_without_the_preview_session_fails_the_preview_and_is_never_sent
    recorder = preview([@store]) do |_|
      # The raw, hooked client carries no Preview session: the write could never be rolled back.
      assert_raises(Sendproof::PreviewTransactionControl) { @raw[:documents].insert_one(_id: "escaped") }
    end
    refute_nil recorder.fault
    assert_empty stored(_id: "escaped"), "The escaped write must be refused before it is sent"
  end

  def test_a_foreign_session_is_refused
    other = @raw.start_session
    recorder = preview([@store]) do |_|
      assert_raises(Sendproof::PreviewTransactionControl) { @client[:documents].insert_one({ _id: "foreign" }, session: other) }
    end
    refute_nil recorder.fault
    assert_empty stored(_id: "foreign")
  ensure
    other&.end_session
  end

  def test_a_handler_commit_never_reaches_the_server_and_fails_the_preview
    recorder = preview([@store]) do |_|
      session = @client.start_session
      @client[:documents].insert_one({ _id: "committed" })
      assert_raises(Sendproof::PreviewTransactionControl) { session.commit_transaction }
      assert_raises(Sendproof::PreviewTransactionControl) { session.abort_transaction }
    end
    refute_nil recorder.fault
    assert_empty stored(_id: "committed")
  end

  def test_a_raw_commit_transaction_command_is_refused_before_sending
    recorder = preview([@store]) do |_|
      session = @client.start_session
      @client[:documents].insert_one({ _id: "raw-commit" })
      assert_raises(Sendproof::PreviewTransactionControl) { @client.database.command({ commitTransaction: 1 }, session: session) }
    end
    refute_nil recorder.fault
    assert_empty stored(_id: "raw-commit")
  end

  def test_start_and_with_transaction_join_the_preview_transaction
    recorder = preview([@store]) do |_|
      @client.with_session do |session|
        session.start_transaction
        session.with_transaction { @client[:documents].insert_one({ _id: "joined" }, session: session) }
      end
    end
    assert_nil recorder.fault
    assert_equal "joined", change(captured(recorder), "insert")[:key]["_id"]
    assert_empty stored(_id: "joined")
  end

  # --- timing, concurrency, snapshots ------------------------------------------------------------

  def test_before_images_come_from_the_transaction_start_not_from_later_commits_by_others
    recorder = preview([@store]) do |_|
      @client[:documents].find(_id: "seeded").to_a # the first reply carries the transaction's snapshot time
      Thread.new { @reader[:documents].insert_one(_id: "concurrent", name: "Committed by another request") }.join
      @client[:documents].update_many({}, "$set" => { touched: true })
    end
    snapshot = captured(recorder)
    assert_equal %w[seeded], snapshot.changes.map { |entry| entry[:key]["_id"] }, "A concurrent commit must not show up as a Preview change"
    assert_equal 1, stored(_id: "concurrent").length
  end

  def test_a_preview_that_outlives_its_time_limit_is_aborted_and_never_confirmed
    @store.unhook!
    @store = Sendproof::Mongo::Store.new(@raw, preview_timeout: 0.2)
    @client = @store.client
    recorder = preview([@store]) do |_|
      @client[:documents].insert_one(_id: "slow")
      sleep 0.6
      # After the limit the transaction is gone: a later write is refused, never committed.
      assert_raises(Sendproof::PreviewTransactionControl, ::Mongo::Error::OperationFailure) { @client[:documents].insert_one(_id: "later") }
    end
    refute_nil recorder.fault
    assert_match(/ran longer/, recorder.fault.message)
    assert_empty stored(_id: "slow")
    assert_empty stored(_id: "later")
  end

  def test_a_preview_keeps_the_mode_it_began_in
    calls = 0
    hello = lambda do
      calls += 1
      raise ::Mongo::Error::SocketError, "unreachable" if calls == 1

      { "setName" => "rs0", "logicalSessionTimeoutMinutes" => 30 }
    end
    @store.unhook!
    @store = Sendproof::Mongo::Store.new(@raw, hello: hello)
    @client = @store.client
    recorder = preview([@store]) do |_|
      # Detection failed when this Preview began, so it runs in guard mode and its writes are blocked...
      assert_raises(Sendproof::PreviewWriteBlocked) { @client[:documents].insert_one(_id: "guarded") }
      # ...even though a later detection now succeeds and says the server supports transactions.
      assert_equal :preview, @store.describe[:mode]
      assert_raises(Sendproof::PreviewWriteBlocked) { @client[:documents].insert_one(_id: "still-guarded") }
    end
    assert_equal "insert", recorder.blocked.operation
    assert_empty stored(_id: "guarded")
  end

  def test_concurrent_previews_never_share_a_session
    results = Array.new(4) do |n|
      Thread.new do
        recorder = preview([@store]) do |_|
          @client[:documents].insert_one(_id: "p#{n}", name: "Preview #{n}")
          sleep 0.05
          @client[:documents].insert_one(_id: "q#{n}", name: "Preview #{n}")
        end
        captured(recorder).changes.map { |entry| entry[:key]["_id"] }.sort
      end
    end.map(&:value)
    assert_equal [%w[p0 q0], %w[p1 q1], %w[p2 q2], %w[p3 q3]], results
    assert_equal ["seeded"], stored.map { |document| document["_id"] }
  end

  def test_a_handler_that_raises_still_aborts_and_ends_its_session
    assert_raises(RuntimeError) do
      preview([@store]) do |_|
        @client[:documents].insert_one(_id: "boom")
        raise "handler failed"
      end
    end
    assert_empty stored(_id: "boom")
  end

  def test_a_write_conflict_between_two_previews_reaches_the_handler
    held = Queue.new
    release = Queue.new
    first = Thread.new do
      preview([@store]) do |_|
        @client[:documents].update_one({ _id: "seeded" }, "$set" => { name: "First" })
        held << true
        release.pop
      end
    end
    held.pop
    error = nil
    preview([@store]) do |_|
      begin
        @client[:documents].update_one({ _id: "seeded" }, "$set" => { name: "Second" })
      rescue ::Mongo::Error::OperationFailure => e
        error = e
      end
    end
    release << true
    first.join
    assert_equal 112, error&.code, "A WriteConflict is the handler's to handle: Previews of one document don't queue"
    assert_equal "Seeded", stored(_id: "seeded").first["name"]
  end

  # --- guard mode on a standalone server ------------------------------------------------------------

  def test_a_standalone_server_runs_in_guard_mode_and_blocks_the_first_write
    @store.unhook!
    @store = Sendproof::Mongo::Store.new(@raw, name: "catalog", hello: -> { { "ismaster" => true } })
    @client = @store.client
    assert_equal({ system: "mongodb", name: "catalog", mode: :guard, reason: Sendproof::Mongo::STANDALONE_REASON }, @store.describe)
    recorder = preview([@store]) do |_|
      assert_equal "Seeded", @client[:documents].find(_id: "seeded").first["name"], "Reads run in guard mode"
      assert_raises(Sendproof::PreviewWriteBlocked) { @client[:documents].insert_one(_id: "guarded") }
      assert_raises(Sendproof::PreviewWriteBlocked) { @client[:documents].find_one_and_update({ _id: "absent" }, "$set" => { a: 1 }) }
    end
    assert_equal "insert", recorder.blocked.operation
    assert_equal "Preview unavailable: this operation writes to MongoDB", recorder.blocked.detail
    assert_empty stored(_id: "guarded")
    assert_empty captured(recorder).changes
  end

  # The pre-send refusal relies on the driver propagating an exception from a command subscriber. Were a
  # future driver to swallow it, the refused command would be sent: the Preview must then never be confirmed.
  def test_a_refused_command_that_reaches_the_server_fails_the_preview
    @store.unhook!
    @store = Sendproof::Mongo::Store.new(@raw, hello: -> { { "ismaster" => true } })
    Thread.current[:swallow_refusals] = true
    recorder = preview([@store]) { |_| @store.client[:documents].insert_one(_id: "leaked") }
    refute_nil recorder.blocked
    refute_nil recorder.fault, "A refused command that was sent can never be a confirmed Preview"
    assert_match(/reached the server/, recorder.fault.message)
    assert_equal 1, stored(_id: "leaked").length, "The driver sent it, which is why the Preview cannot be confirmed"
  ensure
    Thread.current[:swallow_refusals] = nil
  end

  # --- outside a Preview, discovery, coverage ----------------------------------------------------------

  def test_observed_send_commits_once_and_traces_the_insert
    recorder = observe { @client[:documents].insert_one(_id: "sent", name: "Sent", password_hash: "hashed:abc") }
    assert_equal 1, db_entries(recorder, "insert").length
    assert_equal "hashed:abc", stored(_id: "sent").first["password_hash"]
    refute_includes JSON.generate(captured(recorder).logs), "hashed:abc"
  end

  def test_writes_outside_a_capture_are_never_blocked
    @client[:documents].insert_one(_id: "plain")
    @raw[:documents].insert_one(_id: "plain-raw")
    assert_equal 2, stored.count { |document| document["_id"].start_with?("plain") }
  end

  def test_discovery_lists_the_store_in_preview_mode
    assert_equal({ system: "mongodb", name: "catalog", mode: :preview }, @store.describe)
  end

  def test_the_guard_checks_fail_when_the_hook_is_removed
    @store.unhook!
    recorder = preview do |_|
      @raw[:documents].insert_one(_id: "unhooked")
    end
    assert_nil recorder.fault, "Without the hook nothing is refused"
    assert_equal 1, stored(_id: "unhooked").length, "and the write is committed"
  end

  # Through the real Rack transport: a swallowed refusal answers 409, an escaped write answers 500.
  def app
    store = @store
    client = @client
    raw = @raw
    config = build_config
    config.use(CoreHelpers::FakeProvider.new)
    config.data_store(store)
    config.preview_operations = [%w[POST /documents], %w[POST /documents/archive], %w[POST /documents/escape]]
    config.identity = ->(request) { { name: "a", subject: "a" } if request.get_header("HTTP_X_USER") }
    application = lambda do |env|
      request = Rack::Request.new(env)
      Sendproof::Handler.around(env, request:, eligible: true) do
        case request.path_info
        when "/documents"
          client[:documents].insert_one(_id: "rack", name: "Rack")
          [201, { "content-type" => "application/json" }, ['{"ok":true}']]
        when "/documents/archive"
          begin
            client[:documents].aggregate([{ "$out" => "documents_archive" }]).to_a
          rescue Sendproof::PreviewWriteBlocked
            nil
          end
          [204, {}, []]
        else
          begin
            raw[:documents].insert_one(_id: "rack-escape")
          rescue Sendproof::PreviewTransactionControl
            nil
          end
          [200, { "content-type" => "application/json" }, ['{"escaped":false}']]
        end
      end
    end
    Rack::Builder.app { use Sendproof::Middleware, config; run application }
  end

  RACK_HEADERS = { "HTTP_PREFER" => "tx=rollback", "CONTENT_TYPE" => "application/json", "HTTP_X_USER" => "a" }.freeze

  def test_the_transport_confirms_a_rolled_back_preview_with_its_changes
    post "/sendproof/_preview/documents", "{}", RACK_HEADERS
    assert_equal 200, last_response.status, last_response.body
    body = JSON.parse(last_response.body)
    assert_equal true, body["rolledBack"]
    assert_equal "insert", body["changes"].first["operation"]
    assert_equal "mongodb", body["changes"].first["store"]
    assert_empty stored(_id: "rack")
  end

  def test_the_transport_answers_409_for_a_blocked_stage_even_when_the_handler_swallows_the_error
    post "/sendproof/_preview/documents/archive", "{}", RACK_HEADERS
    assert_equal 409, last_response.status, last_response.body
    assert_nil last_response["preference-applied"]
    body = JSON.parse(last_response.body)
    assert_equal %w[mongodb aggregate], body.values_at("store", "operation")
    assert_match(/\$out/, body["detail"])
    assert_empty @reader[:documents_archive].find.to_a
  end

  def test_the_transport_answers_500_when_a_write_escaped_the_session_even_if_the_handler_swallows_it
    post "/sendproof/_preview/documents/escape", "{}", RACK_HEADERS
    assert_equal 500, last_response.status, last_response.body
    assert_nil last_response["preference-applied"]
    assert_empty stored(_id: "rack-escape")
  end
end
