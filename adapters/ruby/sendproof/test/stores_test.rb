# frozen_string_literal: true

require_relative "test_helper"
require "minitest/mock"

# The data-store core (spec/data-stores.md): embedded tables, the shared classification vectors, the
# write guard, the pipeline order, discovery and the `preview: false` marks. Store hooks themselves
# are tested in redis_test.rb, dynamodb_test.rb and mongo_test.rb.
class StoresTest < Minitest::Test
  include Rack::Test::Methods
  include CoreHelpers

  SPEC = File.expand_path("../../../../spec/data-stores", __dir__)
  PREVIEW = { "HTTP_PREFER" => "tx=rollback", "CONTENT_TYPE" => "application/json" }.freeze

  # Stands in for rack-timeout's RequestTimeoutException, Timeout's ExitException and Interrupt: errors
  # that unwind through the handler but aren't StandardErrors.
  Interrupted = Class.new(Exception) # rubocop:disable Lint/InheritException
  Classify = Sendproof::Stores::Classify

  # A guarded store with no server behind it: its "client" calls the guard the way a real hook does,
  # then records what would have been sent.
  class FakeStore < Sendproof::DataStore
    attr_reader :sent, :events
    attr_accessor :begin_error, :finish_error

    def initialize(system: "redis", mode: :guard, name: nil)
      super()
      @system = system
      @mode = mode
      @name = name
      @sent = []
      @events = []
    end

    attr_reader :system

    def describe = { system: @system, name: @name, mode: @mode }

    def begin_preview(_context, _recorder)
      @events << :begin
      raise @begin_error if @begin_error
    end

    def finish_preview(_recorder)
      @events << :finish
      raise @finish_error if @finish_error
    end

    # What a hooked client does for each command.
    def send_command(name, *args)
      Sendproof::Stores::Guard.guard(@system, name.upcase, Classify.redis(name, args))
      @sent << [name, *args]
      :ok
    end
  end

  def setup
    @store = FakeStore.new(name: "cache")
    @provider = CoreHelpers::FakeProvider.new
    @config = build_config(identity: ->(request) { (u = request.get_header("HTTP_X_USER")) && { name: u, role: "admin", subject: u } })
    @config.use(@provider)
    @config.data_store(@store)
    @config.preview_operations = [%w[GET /read], %w[POST /write], %w[POST /swallow], %w[POST /crash], %w[POST /late],
                                  %w[POST /interrupt], %w[POST /spawn], %w[POST /spawn-detached]]
  end

  def app
    config = @config
    store = @store
    application = lambda do |env|
      request = Rack::Request.new(env)
      handled = ->(&work) { Sendproof::Handler.around(env, request:, eligible: true, &work) }
      case [request.request_method, env["PATH_INFO"]]
      when ["GET", "/read"] then handled.call { store.send_command("GET", "k"); [200, { "content-type" => "text/plain" }, ["read"]] }
      when ["POST", "/write"] then handled.call { store.send_command("INCR", "k"); [200, {}, ["wrote"]] }
      when ["POST", "/swallow"]
        # The handler catches the refusal and answers 200: the mark must still win.
        handled.call do
          begin
            store.send_command("INCR", "k")
          rescue Sendproof::PreviewWriteBlocked
            nil
          end
          [200, { "content-type" => "text/plain" }, ["swallowed"]]
        end
      when ["POST", "/crash"] then handled.call { store.send_command("INCR", "k"); raise "after the refusal" }
      # A write from a thread the handler started carries no request attribution.
      when ["POST", "/spawn"] then handled.call { Thread.new { store.send_command("INCR", "k") }.join; [200, {}, ["spawned"]] }
      when ["POST", "/spawn-detached"]
        handled.call { Thread.new { Sendproof.detached { store.send_command("INCR", "k") } }.join; [200, {}, ["detached"]] }
      when ["POST", "/interrupt"] then handled.call { store.send_command("GET", "k"); raise Interrupted, "request timed out" }
      else [404, {}, ["missing"]]
      end
    end
    Rack::Builder.app do
      use Sendproof::Middleware, config
      run application
    end
  end

  def preview(path, method: :post)
    public_send(method, "/sendproof/_preview#{path}", "{}", PREVIEW)
  end

  def json = JSON.parse(last_response.body)

  # Asserts the response is the blocked-Preview problem and no write reached the store.
  def assert_blocked(store: "redis", operation: "INCR")
    assert_equal 409, last_response.status, last_response.body
    assert_nil last_response["preference-applied"], "A blocked Preview must not claim a rollback"
    assert_match(%r{\Aapplication/problem\+json}, last_response["content-type"])
    assert_match(/no-store/, last_response["cache-control"])
    body = json
    assert_equal "preview_unavailable", body["code"]
    assert_equal store, body["store"]
    assert_equal operation, body["operation"]
    assert_equal false, body["rolledBack"]
    assert_equal "Preview unavailable: this operation writes to #{Sendproof::Stores::Guard.store_name(store)}", body["detail"]
    assert_empty @store.sent.select { |command, *| command.casecmp?(operation) }, "The write must never be sent"
  end

  # --- tables and vectors -----------------------------------------------------------------------

  def test_embedded_data_store_tables_match_spec_data_stores
    { "redis" => Sendproof::Stores::Tables::REDIS, "mongodb" => Sendproof::Stores::Tables::MONGODB,
      "dynamodb" => Sendproof::Stores::Tables::DYNAMODB, "elasticsearch" => Sendproof::Stores::Tables::ELASTICSEARCH,
      "firestore" => Sendproof::Stores::Tables::FIRESTORE }.each do |store, embedded|
      assert_equal JSON.parse(File.read(File.join(SPEC, "#{store}.json"))), embedded,
                   "lib/sendproof/stores/tables.rb is out of date: run `rake stores:embed`"
    end
  end

  def test_the_classifiers_pass_every_shared_classification_vector
    cases = JSON.parse(File.read(File.join(SPEC, "classification-cases.json")))
    cases["redis"].each do |vector|
      name, *args = vector["command"]
      assert_equal vector["expect"].to_sym, Classify.redis(name, args), "Redis #{vector['command'].inspect}"
    end
    cases["mongodb"].each do |vector|
      result = Classify.mongo(vector["command"])
      assert_equal vector["expect"].to_sym, result.kind, "MongoDB #{vector['command'].inspect}"
      refusal = vector["refusedInTransaction"]
      message = "MongoDB refusal for #{vector['command'].inspect}"
      refusal.nil? ? assert_nil(result.refused_in_transaction, message) : assert_equal(refusal, result.refused_in_transaction, message)
    end
    cases["dynamodb"].each do |vector|
      assert_equal vector["expect"].to_sym, Classify.dynamodb(vector["operation"], vector["input"]),
                   "DynamoDB #{vector['operation']} #{vector['input'].inspect}"
    end
  end

  # Batch two: Cassandra and Cosmos DB vectors are not run here, because this binding has no hook for them.
  def test_the_classifiers_pass_every_shared_batch_two_vector
    cases = JSON.parse(File.read(File.join(SPEC, "classification-cases.json")))
    refute_empty cases["elasticsearch"]
    cases["elasticsearch"].each do |vector|
      result = Classify.elasticsearch(vector["method"], vector["path"], vector["body"])
      label = "#{vector['method']} #{vector['path']} #{vector['body'].inspect}"
      assert_equal vector["expect"].to_sym, result.kind, "Elasticsearch #{label}"
      assert_equal vector["operation"], result.operation, "Elasticsearch operation for #{label}"
    end
    refute_empty cases["firestore"]
    cases["firestore"].each do |vector|
      if vector["rest"]
        rpc = Classify.firestore_rest(vector["rest"]["method"], vector["rest"]["path"])
        result = Classify.firestore(rpc, vector["rest"]["body"])
      else
        result = Classify.firestore(vector["rpc"], vector["message"])
      end
      assert_equal vector["expect"].to_sym, result.kind, "Firestore #{vector.inspect}"
      assert_equal vector["operation"], result.operation, "Firestore operation for #{vector.inspect}"
    end
  end

  def test_firestore_fails_closed_on_an_unreadable_commit_and_unknown_methods
    assert_equal :write, Classify.firestore("/google.firestore.v1.Firestore/Commit").kind
    assert_equal :write, Classify.firestore("/google.firestore.v1.Firestore/FutureMethod").kind
    assert_equal :write, Classify.firestore("/google.firestore.v2.Firestore/GetDocument").kind
    assert_equal :read, Classify.firestore("/google.firestore.admin.v1.FirestoreAdmin/ListIndexes").kind
    assert_equal :write, Classify.firestore("/google.firestore.admin.v1.FirestoreAdmin/CreateIndex").kind
    assert_equal :write, Classify.firestore("/google.firestore.v1.Firestore/Write").kind
  end

  def test_search_host_declared_reads_match_the_operation_name_exactly
    reads = Sendproof::Stores::Guard.read_set(["POST /{}/_my_plugin_read"], spaces: true)
    assert_equal :read, Classify.elasticsearch("POST", "/articles/_my_plugin_read", nil, reads).kind
    assert_equal :write, Classify.elasticsearch("POST", "/articles/_my_plugin_write", nil, reads).kind
  end

  def test_host_declared_reads_match_exact_names_only
    reads = Sendproof::Stores::Guard.read_set(["MYMODULE.GET"])
    assert_equal :read, Classify.redis("mymodule.get", ["k"], reads)
    assert_equal :write, Classify.redis("MYMODULE.SET", ["k"], reads)
    assert_raises(ArgumentError) { Sendproof::Stores::Guard.read_set(["MYMODULE.*"]) }
    assert_raises(ArgumentError) { Sendproof::Stores::Guard.read_set(["MY MODULE"]) }
  end

  def test_an_aggregation_stage_is_found_at_any_depth
    deep = { "aggregate" => "c", "pipeline" => [{ "$facet" => { "a" => [{ "$lookup" => { "pipeline" => [{ "$merge" => "x" }] } }] } }] }
    assert_equal :write, Classify.mongo(deep).kind
    assert_equal "$merge", Classify.mongo(deep).refused_in_transaction
  end

  def test_store_labels_reject_connection_details
    ["mongodb://user:pw@host/db", "host:27017", "a/b", "", "x" * 65].each do |label|
      assert_raises(ArgumentError, label) { Sendproof::Stores::Guard.store_label(label) }
    end
    assert_equal "catalog", Sendproof::Stores::Guard.store_label("catalog")
  end

  def test_redaction_reaches_every_depth_of_a_document
    redacted = Sendproof::Redaction.deep({ "name" => "x", "profile" => { "apiKey" => "k", "city" => "Leeds" },
                                           "history" => [{ "refreshToken" => "t", "idempotency_key" => "visible" }] })
    assert_equal "[REDACTED]", redacted["profile"]["apiKey"]
    assert_equal "Leeds", redacted["profile"]["city"]
    assert_equal({ "refreshToken" => "[REDACTED]", "idempotency_key" => "visible" }, redacted["history"].first)
  end

  def test_sanitize_document_keeps_names_and_operators
    assert_equal({ "update" => "?", "updates" => [{ "q" => { "_id" => "?" }, "u" => { "$set" => { "name" => "?" } } }] },
                 Sendproof::Stores::Guard.sanitize_document({ update: "c", updates: [{ q: { _id: 7 }, u: { "$set" => { name: "secret" } } }] }))
  end

  # --- the guard and the pipeline ---------------------------------------------------------------

  def test_a_read_in_a_preview_is_confirmed_and_a_write_is_refused_before_sending
    preview("/read", method: :get)
    assert_equal 200, last_response.status, last_response.body
    assert_equal "tx=rollback", last_response["preference-applied"]
    assert_equal [["GET", "k"]], @store.sent

    preview("/write")
    assert_blocked
  end

  def test_a_blocked_preview_answers_409_even_when_the_handler_catches_the_error_and_returns_200
    preview("/swallow")
    assert_blocked
  end

  def test_a_handler_that_raises_after_a_blocked_write_still_gets_the_409
    preview("/crash")
    assert_blocked
  end

  def test_a_blocked_preview_rolls_the_sql_provider_back_and_finishes_every_store
    preview("/write")
    assert_equal [:rollback, :close], @provider.sessions.last.log
    assert_equal [:begin, :finish], @store.events
  end

  # A timeout that unwinds through the handler must still abort every store and roll SQL back, or the
  # store transaction stays open and the SQL connection (and, on MySQL, the Previews' turn) is never
  # handed back. The error then propagates as it would without Sendproof.
  def test_an_error_that_is_not_a_standard_error_still_finishes_every_store_and_rolls_back
    assert_raises(Interrupted) { preview("/interrupt") }
    assert_equal [:begin, :finish], @store.events
    assert_equal [:rollback, :close], @provider.sessions.last.log
  end

  # One store's cleanup failing, however it fails, must not skip the other stores or the SQL rollback.
  def test_a_store_whose_finish_raises_any_error_never_skips_the_other_stores_or_the_rollback
    first = FakeStore.new(system: "mongodb")
    first.finish_error = Interrupted.new("abort interrupted")
    config = build_config
    provider = CoreHelpers::FakeProvider.new
    config.use(provider)
    config.data_store(first)
    config.data_store(@store)
    config.preview_operations = [%w[GET /read]]
    store = @store
    application = lambda do |env|
      Sendproof::Handler.around(env, request: Rack::Request.new(env), eligible: true) { store.send_command("GET", "k"); [200, {}, ["ok"]] }
    end
    request = Rack::MockRequest.new(Rack::Builder.app { use(Sendproof::Middleware, config); run(application) })
    assert_raises(Interrupted) { request.get("/sendproof/_preview/read", PREVIEW) }
    assert_equal [:begin, :finish], @store.events
    assert_equal [:rollback, :close], provider.sessions.last.log
  end

  # --- writes without request attribution -------------------------------------------------------

  # The guard can't tell a write from a thread the handler started apart from background work: while a
  # Preview is open, such a write fails it rather than let it confirm a rollback that didn't happen.
  def test_an_unattributed_write_while_a_preview_is_open_fails_the_preview_with_500
    preview("/spawn")
    assert_equal 500, last_response.status, last_response.body
    assert_nil last_response["preference-applied"]
    assert_equal [["INCR", "k"]], @store.sent, "The write ran: the guard couldn't attribute it to the Preview"
  end

  def test_a_write_marked_detached_never_fails_a_preview
    preview("/spawn-detached")
    assert_equal 200, last_response.status, last_response.body
  end

  def test_an_unattributed_write_fails_every_open_preview_and_attributed_ones_fail_none
    first = Sendproof::Recorder.new(rollback: true)
    second = Sendproof::Recorder.new(rollback: true)
    [first, second].each { |recorder| Sendproof::Attribution.open(recorder) }
    Sendproof::Attribution.request { @store.send_command("INCR", "k") }
    Sendproof::Capture.with(Sendproof::Recorder.new(rollback: false)) { @store.send_command("INCR", "k") }
    assert_nil first.fault, "A write from a request Sendproof saw is attributed"
    @store.send_command("INCR", "k")
    refute_nil first.fault
    refute_nil second.fault
  ensure
    [first, second].each { |recorder| Sendproof::Attribution.close(recorder) }
  end

  def test_an_unattributed_write_with_no_open_preview_fails_nothing
    @store.send_command("INCR", "k")
    preview("/read", method: :get)
    assert_equal 200, last_response.status
  end

  def test_the_guard_never_blocks_outside_a_preview
    assert_nil Sendproof::Stores::Guard.guard("redis", "INCR", :write)
    @store.send_command("INCR", "k")
    assert_equal [["INCR", "k"]], @store.sent
  end

  def test_a_failed_store_finish_outranks_a_blocked_write
    @store.finish_error = RuntimeError.new("abort failed")
    preview("/write")
    assert_equal 500, last_response.status
    assert_nil last_response["preference-applied"]
  end

  def test_a_recorded_fault_outranks_a_blocked_write_and_withholds_confirmation
    config = @config
    faulting = lambda do |env|
      Sendproof::Handler.around(env, request: Rack::Request.new(env), eligible: true) do
        Sendproof::Stores::Guard.refuse_in_preview("a commit reached the server")
        begin
          Sendproof::Stores::Guard.guard("redis", "INCR", :write)
        rescue Sendproof::PreviewWriteBlocked
          nil
        end
        [200, {}, ["ok"]]
      end
    end
    response = Rack::MockRequest.new(Rack::Builder.app { use(Sendproof::Middleware, config); run(faulting) })
                                .post("/sendproof/_preview/write", PREVIEW.merge(input: "{}"))
    assert_equal 500, response.status
    assert_nil response["preference-applied"]
  end

  # The negative test of the acceptance checks: with the guard turned off, the guard checks fail.
  def test_the_guard_checks_fail_when_the_guard_is_turned_off
    Sendproof::Stores::Guard.stub(:guard, nil) do
      preview("/swallow")
      assert_raises(Minitest::Assertion) { assert_blocked }
    end
  end

  def test_a_store_that_fails_to_begin_answers_500
    @store.begin_error = RuntimeError.new("no session")
    preview("/read", method: :get)
    assert_equal 500, last_response.status
    assert_nil last_response["preference-applied"]
    assert_includes @store.events, :finish
  end

  # --- discovery and preview: false ---------------------------------------------------------------

  def sign_in_headers = { "HTTP_X_USER" => "admin" }

  def test_capabilities_list_each_registered_store_with_its_mode
    @config.data_store(FakeStore.new(system: "mongodb", mode: :preview))
    get "/sendproof/_api/capabilities", {}, sign_in_headers
    stores = json["dataStores"]
    assert_equal [{ "system" => "redis", "name" => "cache", "mode" => "guard" }, { "system" => "mongodb", "mode" => "preview" }], stores
  end

  def test_capabilities_name_the_binding_and_the_database_system
    provider = @provider
    provider.define_singleton_method(:database_system) { "sqlite" }
    get "/sendproof/_api/capabilities", {}, sign_in_headers
    assert_equal({ "language" => "ruby", "framework" => "Rack" }, json["binding"])
    assert_equal({ "name" => "fake", "system" => "sqlite" }, json["database"])
  end

  def test_operations_marked_preview_false_are_reported_with_their_reason
    @config.preview_unavailable = [{ method: "delete", path: "/sessions/{id}", reason: "Clears the Redis session", stores: %w[redis] }]
    get "/sendproof/_api/capabilities", {}, sign_in_headers
    assert_equal [{ "method" => "DELETE", "path" => "/sessions/{id}", "reason" => "Clears the Redis session", "stores" => ["redis"] }],
                 json["previewUnavailable"]
  end

  # --- Preview without a SQL provider ---------------------------------------------------------------

  def test_a_preview_runs_without_a_sql_provider_when_data_stores_are_registered
    @config.providers = []
    preview("/read", method: :get)
    assert_equal 200, last_response.status, last_response.body
    assert_equal "tx=rollback", last_response["preference-applied"]
    preview("/write")
    assert_blocked
  end

  def test_a_preview_without_a_provider_or_a_store_is_still_unavailable
    @config.providers = []
    @config.data_stores = []
    preview("/read", method: :get)
    assert_equal 503, last_response.status
  end
end
