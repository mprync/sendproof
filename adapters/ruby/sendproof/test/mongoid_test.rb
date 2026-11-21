# frozen_string_literal: true

require_relative "stores_support"
require "sendproof/mongoid"

# The Mongoid store against the compose replica set (docker compose -f tests/conformance/compose.yml up -d --wait mongodb).
class MongoidHookTest < Minitest::Test
  include StoreHelpers

  # Mongoid keeps its clients in one process-wide registry, so the suite configures it once.
  DATABASE = "tb_mongoid_#{SecureRandom.hex(4)}"

  class Doc
    include ::Mongoid::Document
    store_in collection: "documents"
    field :name, type: String
    field :profile, type: Hash
    field :password_hash, type: String
    field :hits, type: Integer, default: 0
  end

  def self.configure
    return if @configured

    @configured = true
    ::Mongoid.logger = Logger.new(IO::NULL)
    url = SERVERS[:mongodb].sub(%r{/\?}, "/#{DATABASE}?")
    ::Mongoid.load_configuration(clients: { default: { uri: url, options: { server_selection_timeout: 3 } } })
    # Mongoid hands the driver its own logger when it configures; keep the suite quiet.
    ::Mongo::Logger.logger = Logger.new(IO::NULL)
    Minitest.after_run { ::Mongoid::Clients.with_name(:default).database.drop rescue nil }
  end

  def setup
    needs(:mongodb)
    self.class.configure
    Doc.delete_all
    @store = Sendproof::Mongoid::Store.new(name: "catalog")
    @reader = ::Mongo::Client.new(SERVERS[:mongodb].sub(%r{/\?}, "/#{DATABASE}?"), monitoring: false, server_selection_timeout: 3)
    @seeded = Doc.create!(name: "Seeded", profile: { "city" => "Leeds" }, password_hash: "hashed:seeded-secret")
  end

  def teardown
    @store&.unhook!
    @reader&.close
  end

  def stored(filter = {}) = @reader[:documents].find(filter).to_a

  def change(recorder, operation) = captured(recorder).changes.find { |entry| entry[:operation] == operation }

  def test_save_update_and_destroy_run_in_the_preview_transaction_and_roll_back
    id = @seeded.id
    recorder = preview([@store]) do |_|
      created = Doc.create!(name: "Draft", profile: { "city" => "York" }, password_hash: "hashed:mongoid-secret")
      assert_equal "Draft", Doc.find(created.id).name, "The handler reads its own writes"
      Doc.find(id).update!(name: "Renamed")
      Doc.where(name: "Draft").destroy_all
    end
    assert_nil recorder.blocked
    assert_nil recorder.fault
    assert_equal ["Seeded"], stored.map { |document| document["name"] }, "An independent read finds only the seeded document, unchanged"
    update = change(recorder, "update")
    assert_equal %w[Seeded Renamed], [update[:before]["name"], update[:after]["name"]]
    assert_equal "[REDACTED]", update[:after]["password_hash"]
    refute_includes JSON.generate(captured(recorder).changes), "mongoid-secret"
  end

  def test_a_new_document_is_an_insert_change_with_nesting
    recorder = preview([@store]) { |_| Doc.create!(name: "Draft", profile: { "city" => "York" }) }
    insert = change(recorder, "insert")
    assert_equal({ "city" => "York" }, insert[:after]["profile"])
    assert_nil insert[:before]
    assert_equal "documents", insert[:table]
    assert_equal 1, stored.length
  end

  def test_with_session_and_transaction_join_the_preview_transaction
    recorder = preview([@store]) do |_|
      Doc.with_session { Doc.create!(name: "in with_session") }
      Doc.transaction { Doc.create!(name: "in transaction") }
      Doc.transaction { Doc.create!(name: "rolled back by the handler"); raise ::Mongoid::Errors::Rollback }
    end
    assert_nil recorder.fault
    assert_equal 3, captured(recorder).changes.count { |entry| entry[:operation] == "insert" }
    assert_equal 1, stored.length
  end

  def test_model_collection_writes_bypass_the_session_and_fail_the_preview_before_sending
    recorder = preview([@store]) do |_|
      assert_raises(Sendproof::PreviewTransactionControl) { Doc.collection.insert_one(_id: BSON::ObjectId.new, name: "bypass") }
    end
    refute_nil recorder.fault
    assert_equal ["Seeded"], stored.map { |document| document["name"] }
  end

  def test_unsupported_operations_are_blocked_with_a_reason
    assert_blocked_in_preview("mongodb", "count", [@store]) { Doc.estimated_count }
    assert_blocked_in_preview("mongodb", "aggregate", [@store]) { Doc.collection.aggregate([{ "$out" => "documents_archive" }]).to_a }
    assert_empty @reader[:documents_archive].find.to_a
  end

  def test_a_standalone_server_runs_in_guard_mode_and_blocks_the_first_write
    @store.unhook!
    @store = Sendproof::Mongoid::Store.new(name: "catalog", hello: -> { { "ismaster" => true } })
    recorder = preview([@store]) do |_|
      assert_equal "Seeded", Doc.first.name
      assert_raises(Sendproof::PreviewWriteBlocked) { Doc.create!(name: "guarded") }
      assert_raises(Sendproof::PreviewWriteBlocked) { Doc.first.update!(name: "guarded") }
    end
    assert_equal "Preview unavailable: this operation writes to MongoDB", recorder.blocked.detail
    assert_equal ["Seeded"], stored.map { |document| document["name"] }
  end

  def test_a_handler_that_swallows_the_blocked_error_still_leaves_the_preview_blocked
    @store.unhook!
    @store = Sendproof::Mongoid::Store.new(name: "catalog", hello: -> { { "ismaster" => true } })
    recorder = preview([@store]) do |_|
      begin
        Doc.create!(name: "swallowed")
      rescue Sendproof::PreviewWriteBlocked
        nil
      end
    end
    refute_nil recorder.blocked
  end

  def test_writes_outside_a_capture_and_observed_sends_commit_normally
    Doc.create!(name: "plain")
    recorder = observe { Doc.create!(name: "sent") }
    assert_equal 1, db_entries(recorder, "insert").length
    assert_equal %w[Seeded plain sent], stored.map { |document| document["name"] }.sort
  end

  def test_the_session_is_ambient_only_during_a_preview
    assert_nil ::Mongoid::Threaded.get_session(client: ::Mongoid::Clients.with_name(:default))
    preview([@store]) do |_|
      refute_nil ::Mongoid::Threaded.get_session(client: ::Mongoid::Clients.with_name(:default))
      refute_nil ::Mongoid::Threaded.get_session(client: ::Mongoid::Clients.with_name(:default).with(read: { mode: :primary }))
    end
  end

  def test_discovery_lists_the_store_in_preview_mode
    assert_equal({ system: "mongodb", name: "catalog", mode: :preview }, @store.describe)
  end
end
