# frozen_string_literal: true

require_relative "stores_support"
require "sendproof/mongo"

# The MongoDB engine and plain-driver store against the compose replica set
# (docker compose -f tests/conformance/compose.yml up -d --wait mongodb).

# Pins the driver behavior the pre-send refusal relies on: an exception raised from a command subscriber's
# +started+ leaves the driver before any byte of that command reaches a socket. The driver names the socket
# in each started event, and a refused command marks its connection failed, so any later write to the
# socket of a refused command is recorded as a violation.
module MongoSocketWatch
  module Subscriber
    def started(event)
      super
    rescue Sendproof::PreviewWriteBlocked, Sendproof::PreviewTransactionControl
      Thread.current[:mongo_socket_watch]&.then do |watch|
        watch[:refused][event.socket_object_id] = event.command_name
        watch[:attempts][event.command_name] += 1
      end
      raise
    end
  end

  module Socket
    def write(*args, **options)
      watch = Thread.current[:mongo_socket_watch]
      watch[:violations] << watch[:refused][object_id] if watch&.dig(:refused)&.key?(object_id)
      super
    end
  end

  # Counts concurrent and interrupted aborts of Preview transactions, from any thread.
  module Abort
    class << self
      attr_accessor :watch
    end

    def abort_transaction(*args, **options)
      watch = Abort.watch or return super
      watch[:lock].synchronize { watch[:max] = [watch[:max], watch[:running] += 1].max }
      done = false
      begin
        sleep watch[:delay]
        result = super
        done = true
        result
      ensure
        watch[:lock].synchronize do
          watch[:running] -= 1
          watch[:interrupted] += 1 unless done
        end
      end
    end
  end
end
Sendproof::Mongo::Subscriber.prepend(MongoSocketWatch::Subscriber)
Mongo::Socket.prepend(MongoSocketWatch::Socket)
Mongo::Session.prepend(MongoSocketWatch::Abort)

# Prepended last, so it wraps the watch above: lets one test stand in for a driver that swallows an exception raised from a command subscriber.
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

  # A handler that gets hold of the Preview session still can't end its transaction: whatever calls the
  # driver's own commit or abort, the command is refused by name before it is sent, on every hooked client.
  def test_a_handler_holding_the_preview_session_can_never_commit_it
    recorder = preview([@store]) do |_|
      session = @client.start_session
      @client[:documents].insert_one({ _id: "held" })
      commit = ::Mongo::Session.instance_method(:commit_transaction)
      assert_raises(Sendproof::PreviewTransactionControl) { commit.bind(session).call }
      derived = @raw.with(app_name: "holder")
      @others << derived
      assert_raises(::Mongo::Error::InvalidSession) { derived.database.command({ commitTransaction: 1 }, session: session) }
    end
    refute_nil recorder.fault
    assert_empty stored(_id: "held")
    # Ending the session by hand leaves the transaction to the server's lifetime limit: the Preview fails.
    assert_raises(::Mongo::Error::InvalidSession) do
      preview([@store]) do |_|
        session = @client.start_session
        @client[:documents].insert_one({ _id: "ended" })
        assert_raises(Sendproof::PreviewTransactionControl) { ::Mongo::Session.instance_method(:end_session).bind(session).call }
      end
    end
    assert_empty stored(_id: "ended")
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

  # A thread the handler starts carries no request: its write can't join the Preview transaction and runs,
  # so the Preview must fail rather than confirm. The same write marked detached is background work.
  def test_a_write_from_a_thread_the_handler_started_fails_the_preview
    recorder = preview([@store]) { |_| Thread.new { @raw[:documents].insert_one(_id: "threaded") }.join }
    refute_nil recorder.fault
    assert_match(/outside any request/, recorder.fault.message)
    detached = preview([@store]) { |_| Thread.new { Sendproof.detached { @raw[:documents].insert_one(_id: "worker") } }.join }
    assert_nil detached.fault
  end

  # The tripwire proves it is installed on the guarded client itself, not on some other client.
  def test_a_preview_refuses_to_start_when_the_monitor_left_the_guarded_client
    guard_mode_store
    @raw.unsubscribe(::Mongo::Monitoring::COMMAND, @store.engine.subscriber)
    assert_raises(Sendproof::ConfigurationError) { preview([@store]) { |_| @client[:documents].insert_one(_id: "unguarded") } }
    assert_empty stored(_id: "unguarded")
  end

  # --- the driver behavior the guard relies on (mongo 2.26) ---------------------------------------------

  # Runs +block+, expecting a refusal, and returns the refused commands that wrote to a socket anyway.
  def socket_violations
    watch = { refused: {}, violations: [], attempts: Hash.new(0) }
    Thread.current[:mongo_socket_watch] = watch
    yield
    watch
  ensure
    Thread.current[:mongo_socket_watch] = nil
  end

  def guard_mode_store
    @store.unhook!
    @store = Sendproof::Mongo::Store.new(@raw, hello: -> { { "ismaster" => true } })
    @client = @store.client
  end

  # Every write path of the driver, refused in guard mode: none may reach a socket, none may be retried,
  # and a write the driver splits into several commands stops at the first.
  def test_a_refusal_from_the_subscriber_stops_every_driver_write_path_before_the_socket
    guard_mode_store
    documents = @client[:documents]
    bucket = @client.database.fs(bucket_name: "files")
    paths = {
      "insert_one" => -> { documents.insert_one(_id: "w1") },
      "insert_many split" => -> { documents.insert_many(Array.new(100_001) { |n| { n: n } }) },
      "bulk_write unordered" => -> { documents.bulk_write([{ insert_one: { _id: "w2" } }, { delete_one: { filter: { _id: "seeded" } } }], ordered: false) },
      "update_many" => -> { documents.update_many({}, "$set" => { a: 1 }) },
      "replace_one" => -> { documents.replace_one({ _id: "seeded" }, { name: "Replaced" }) },
      "delete_many" => -> { documents.delete_many({}) },
      "find_one_and_update" => -> { documents.find_one_and_update({ _id: "seeded" }, "$set" => { a: 1 }) },
      "find_one_and_replace" => -> { documents.find_one_and_replace({ _id: "seeded" }, { a: 1 }) },
      "find_one_and_delete" => -> { documents.find_one_and_delete(_id: "seeded") },
      "aggregate $out" => -> { documents.aggregate([{ "$out" => "copied" }]).to_a },
      "aggregate $merge" => -> { documents.aggregate([{ "$merge" => { into: "copied" } }]).to_a },
      "database.command" => -> { @client.database.command(insert: "documents", documents: [{ _id: "w3" }]) },
      "create index" => -> { documents.indexes.create_one({ name: 1 }) },
      "drop" => -> { documents.drop },
      "GridFS upload" => -> { bucket.upload_from_stream("f.txt", StringIO.new("data")) }
    }
    paths.each do |label, call|
      watch = nil
      preview([@store]) do |_|
        watch = socket_violations { assert_raises(Sendproof::PreviewWriteBlocked, label) { call.call } }
      end
      assert_empty watch[:violations], "#{label}: a refused command reached a socket"
      assert watch[:attempts].values.all? { |count| count == 1 }, "#{label}: the refused command was retried: #{watch[:attempts]}"
    end
    assert_equal [SEEDED["_id"]], stored.map { |document| document["_id"] }
    assert_equal SEEDED["name"], stored.first["name"]
    assert_empty @reader.database.collection_names.grep(/copied|files/)
  end

  # The negative check of the pin: were the driver to carry on after the exception, the watch sees the send.
  def test_the_socket_watch_sees_a_refused_command_that_is_sent
    guard_mode_store
    Thread.current[:swallow_refusals] = true
    watch = nil
    preview([@store]) { |_| watch = socket_violations { @client[:documents].insert_one(_id: "leaked") } }
    assert_equal ["insert"], watch[:violations]
  ensure
    Thread.current[:swallow_refusals] = nil
  end

  # In preview mode a write without the Preview session is refused by the same subscriber, on the same terms.
  def test_a_refused_escape_never_reaches_a_socket
    watch = nil
    preview([@store]) do |_|
      watch = socket_violations do
        assert_raises(Sendproof::PreviewTransactionControl) { @raw[:documents].insert_one(_id: "escaped") }
        assert_raises(Sendproof::PreviewTransactionControl) { @raw[:documents].update_one({ _id: "seeded" }, "$set" => { a: 1 }) }
      end
    end
    assert_empty watch[:violations]
    assert_equal({ "insert" => 1, "update" => 1 }, watch[:attempts])
    assert_empty stored(_id: "escaped")
  end

  # Client#with and an option outside the CRUD set builds a new cluster with a fresh Monitoring: without
  # the store's subscriber on it, every command of the derived client would bypass the guard.
  def test_a_client_derived_with_new_cluster_options_is_still_guarded
    guard_mode_store
    preview([@store]) do |_|
      derived = @client.with(app_name: "derived")
      @others << derived.__target__
      assert_raises(Sendproof::PreviewWriteBlocked) { derived[:documents].insert_one(_id: "derived") }
      silent = @raw.with(monitoring: false, socket_timeout: 7)
      @others << silent
      assert_raises(Sendproof::PreviewWriteBlocked) { silent[:documents].insert_one(_id: "silent") }
    end
    assert_empty stored(_id: "derived")
    assert_empty stored(_id: "silent")
  end

  def test_a_client_derived_with_new_cluster_options_cannot_escape_the_preview_transaction
    recorder = preview([@store]) do |_|
      derived = @raw.with(server_selection_timeout: 4)
      @others << derived
      assert_raises(Sendproof::PreviewTransactionControl) { derived[:documents].insert_one(_id: "derived") }
    end
    refute_nil recorder.fault
    assert_empty stored(_id: "derived")
  end

  # The time limit and the end of the Preview both abort the transaction. They must take turns: one
  # interrupted mid-abort, or both at once on one session, leaves the driver's session state undefined.
  def test_the_time_limit_and_the_finish_never_abort_at_once
    @store.unhook!
    @store = Sendproof::Mongo::Store.new(@raw, preview_timeout: 0.2)
    @client = @store.client
    watch = { lock: Mutex.new, running: 0, max: 0, interrupted: 0, delay: 0.4 }
    MongoSocketWatch::Abort.watch = watch
    recorder = preview([@store]) do |_|
      @client[:documents].insert_one(_id: "slow")
      sleep 0.3 # the timer is now aborting; the Preview finishes while it is
    end
    sleep 0.5
    assert_equal 0, watch[:interrupted], "An abort was interrupted"
    assert_equal 1, watch[:max], "Two aborts ran at once"
    refute_nil recorder.fault
    assert_empty stored(_id: "slow")
  ensure
    MongoSocketWatch::Abort.watch = nil
  end

  # A direct connection is a "single" topology: the two client-side checks are lifted on the Preview
  # session only. A session of the same client outside a Preview keeps them.
  def test_the_direct_connection_checks_are_lifted_on_the_preview_session_only
    skip "needs a direct connection" unless @raw.cluster.single?
    preview([@store]) { |_| @client[:documents].insert_one(_id: "direct") }
    session = @raw.start_session
    assert_raises(::Mongo::Error::TransactionsNotSupported) { session.start_transaction }
    session.end_session
    assert_empty stored(_id: "direct")
  end

  Event = Struct.new(:command_name, :database_name, :command, :request_id)

  # An authentication exchange on a connection opened during a Preview: the driver redacts the command to an
  # empty document, which must not be classified as an unknown command (a write) and block the Preview.
  def test_a_redacted_authentication_command_never_blocks_a_preview
    @store.unhook!
    @store = Sendproof::Mongo::Store.new(@raw, hello: -> { { "ismaster" => true } }) # guard mode blocks every write
    recorder = preview([@store]) do |_|
      %w[saslStart saslContinue authenticate getnonce].each do |name|
        @store.engine.command_started(Event.new(name, "admin", {}, 1))
      end
      assert_raises(Sendproof::PreviewWriteBlocked) { @store.engine.command_started(Event.new("insert", "x", { "insert" => "c" }, 2)) }
    end
    assert_equal "insert", recorder.blocked.operation
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

  def test_a_client_without_command_monitoring_is_refused
    blind = ::Mongo::Client.new(@url, monitoring: false, server_selection_timeout: 3)
    assert_raises(ArgumentError) { Sendproof::Mongo::Store.new(blind) }
  ensure
    blind&.close
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
