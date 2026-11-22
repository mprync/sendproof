# frozen_string_literal: true

require_relative "stores_support"
require "google/firestore/v1/firestore_services_pb"
require "sendproof/firestore"

# A Firestore server on a free local port, in this process. It records every RPC that reaches it, so a
# test can prove a refused write was never sent, and answers each call with an empty but valid reply.
class FakeFirestoreServer
  V1 = Google::Cloud::Firestore::V1

  # The service the gRPC server runs: each method records its name (and a +Commit+'s write count).
  class Service < V1::Firestore::Service
    def initialize(received)
      super()
      @received = received
    end

    def get_document(request, _call) = (@received << "GetDocument"; V1::Document.new(name: request.name))
    def commit(request, _call) = (@received << (request.writes.empty? ? "Commit(empty)" : "Commit"); V1::CommitResponse.new)
    def batch_write(_request, _call) = (@received << "BatchWrite"; V1::BatchWriteResponse.new)
    def begin_transaction(_request, _call) = (@received << "BeginTransaction"; V1::BeginTransactionResponse.new(transaction: "tx"))
    def rollback(_request, _call) = (@received << "Rollback"; Google::Protobuf::Empty.new)
    def batch_get_documents(_request, _call) = (@received << "BatchGetDocuments"; [].each)
    def run_query(_request, _call) = (@received << "RunQuery"; [V1::RunQueryResponse.new(skipped_results: 0)].each)
    def listen(requests, _call) = (@received << "Listen"; requests.each { |_| }; [].each)
    def write(requests, _call) = (@received << "Write"; requests.each { |_| }; [].each)
  end

  attr_reader :received

  def initialize
    @received = Queue.new
    @server = GRPC::RpcServer.new
    @port = @server.add_http2_port("127.0.0.1:0", :this_port_is_insecure)
    @server.handle(Service.new(@received))
    @thread = Thread.new { @server.run }
    @server.wait_till_running
  end

  def host = "127.0.0.1:#{@port}"

  # The RPC names the server has received so far.
  def seen = Array.new(@received.size) { @received.pop }.tap { |names| names.each { |name| @received << name } }

  def stop
    @server.stop
    @thread.join(5)
  end
end

# The Firestore hook against the in-process server: no Firestore emulator is needed.
class FirestoreHookTest < Minitest::Test
  include StoreHelpers

  def setup
    @server = FakeFirestoreServer.new
    @store = Sendproof::Firestore::Store.new(name: "orders")
    @firestore = new_client
    # The gem builds its gRPC client on first use; build it now, while the store is registered, so a test
    # that unhooks the store first still has a client built under it.
    @firestore.service.firestore
  end

  def teardown
    @store&.unhook!
    @server.stop
  end

  # A client built after the store, so its channel carries the interceptor.
  def new_client(**options) = Google::Cloud::Firestore.new(project_id: "bench", emulator_host: @server.host, **options)

  def seen = @server.seen
  def blocked_write(operation, &block) = assert_blocked_in_preview("firestore", operation, &block)

  def test_reads_in_a_preview_run_and_are_logged_with_their_values_replaced
    recorder = preview do |_|
      @firestore.doc("orders/o-1").get
      @firestore.col("orders").where("status", "==", "open").get.to_a
    end
    assert_nil recorder.blocked
    assert_equal %w[BatchGetDocuments RunQuery], seen
    get = db_entries(recorder, "BatchGetDocuments").fetch(0)
    assert_equal "firestore", get[:db][:system]
    assert_equal "orders", get[:db][:target]
    query = db_entries(recorder, "RunQuery").fetch(0)
    assert_equal "orders", query[:db][:target]
    refute_includes query[:db][:statement], "open", "a query value never reaches the Db entry"
    assert_includes query[:db][:statement], '"?"'
  end

  def test_every_kind_of_write_is_refused_before_it_is_sent
    {
      "create" => -> { @firestore.doc("orders/new").create({ status: "new" }) },
      "set" => -> { @firestore.doc("orders/o-1").set({ status: "set" }) },
      "update" => -> { @firestore.doc("orders/o-1").update({ status: "updated" }) },
      "delete" => -> { @firestore.doc("orders/o-1").delete },
      "batch" => -> { @firestore.batch { |batch| batch.set(@firestore.doc("orders/b"), { status: "b" }) } }
    }.each do |name, write|
      recorder = assert_blocked_in_preview("firestore", "Commit") { write.call }
      assert_equal "Preview unavailable: this operation writes to Firestore", recorder.blocked.detail, name
      assert db_entries(recorder, "Commit").first[:db][:blocked], name
    end
    assert_empty seen, "A refused write must never reach Firestore"
  end

  # BulkWriter sends from threads of its own, which carry no request: the write isn't refused but it fails
  # the Preview (see test_a_write_from_a_thread_the_handler_started_fails_the_preview). The generated
  # client's BatchWrite, sent from the handler's thread, is refused.
  def test_a_batch_write_is_refused
    stub = @firestore.service.firestore
    assert_blocked_in_preview("firestore", "BatchWrite") do
      stub.batch_write(database: "projects/bench/databases/(default)", writes: [{ delete: "projects/bench/databases/(default)/documents/orders/o" }])
    end
    refute_includes seen, "BatchWrite"
  end

  def test_a_transaction_that_writes_runs_its_reads_and_is_refused_at_commit
    recorder = assert_blocked_in_preview("firestore", "Commit") do
      @firestore.transaction do |tx|
        tx.get(@firestore.doc("orders/o-1"))
        tx.set(@firestore.doc("orders/o-1"), { status: "tx" })
      end
    end
    assert_includes db_entries(recorder).map { |entry| entry[:db][:operation] }, "BatchGetDocuments"
    refute_includes seen, "Commit"
  end

  def test_a_transaction_that_only_reads_is_allowed_and_a_commit_with_no_writes_is_a_session_call
    recorder = preview { |_| @firestore.transaction { |tx| tx.get(@firestore.doc("orders/o-1")) } }
    assert_nil recorder.blocked
    refute_includes seen, "Commit"
    stub = @firestore.service.firestore
    empty = preview { |_| stub.commit(database: "projects/bench/databases/(default)", transaction: "tx") }
    assert_nil empty.blocked, "a Commit with no writes only ends a transaction that wrote nothing"
    assert_includes seen, "Commit(empty)"
    assert_empty db_entries(empty, "Commit"), "a session call is not logged"
  end

  # Write is a bidirectional stream; a unary-only interceptor would let it through.
  def test_the_write_stream_is_refused_before_its_first_message
    stub = @firestore.service.firestore
    requests = [Google::Cloud::Firestore::V1::WriteRequest.new(database: "projects/bench/databases/(default)")]
    assert_blocked_in_preview("firestore", "Write") { stub.write(requests.each).to_a }
    refute_includes seen, "Write"
  end

  def test_the_listen_stream_is_a_read
    stub = @firestore.service.firestore
    request = Google::Cloud::Firestore::V1::ListenRequest.new(database: "projects/bench/databases/(default)")
    recorder = preview { |_| stub.listen([request].each).to_a }
    assert_nil recorder.blocked
  end

  def test_a_host_that_replaces_the_clients_interceptors_cannot_drop_the_guard
    client = Google::Cloud::Firestore::V1::Firestore::Client.new do |config|
      config.credentials = :this_channel_is_insecure
      config.endpoint = @server.host
      config.interceptors = []
    end
    assert_blocked_in_preview("firestore", "Commit") do
      client.commit(database: "projects/bench/databases/(default)",
                    writes: [{ delete: "projects/bench/databases/(default)/documents/orders/o-1" }])
    end
    assert_empty seen
  end

  def test_a_client_built_before_the_store_refuses_the_store
    @store.unhook!
    early = new_client
    early.service.firestore # builds the channel while no store is registered
    error = assert_raises(Sendproof::ConfigurationError) { Sendproof::Firestore::Store.new }
    assert_match(/built before this store/, error.message)
    assert_nil Sendproof::Firestore.store, "a store that failed to start is not left registered"
  ensure
    # The early client stays visible until it is collected; mark it so later tests can register a store.
    early&.service&.firestore&.firestore_stub&.instance_variable_set(:@sendproof_guarded, true)
    @store = Sendproof::Firestore::Store.new(name: "orders")
  end

  def test_firestore_over_rest_cannot_be_guarded
    error = assert_raises(Sendproof::ConfigurationError) { new_client(transport: :rest).service.firestore }
    assert_match(/REST/, error.message)
  end

  def test_a_write_from_a_thread_the_handler_started_fails_the_preview
    recorder = preview { |_| Thread.new { @firestore.doc("orders/t").delete }.join }
    refute_nil recorder.fault
    assert_match(/outside any request/, recorder.fault.message)
    detached = preview { |_| Thread.new { Sendproof.detached { @firestore.doc("orders/w").delete } }.join }
    assert_nil detached.fault
  end

  def test_send_and_observed_send_are_never_blocked
    @firestore.doc("orders/s").set({ status: "sent" })
    recorder = observe { |_| @firestore.doc("orders/o").set({ status: "observed" }) }
    assert_nil recorder.blocked
    assert_equal %w[Commit Commit], seen
    assert_equal "Commit", db_entries(recorder).fetch(0)[:db][:operation]
    refute_includes db_entries(recorder).fetch(0)[:db][:statement], "observed"
  end

  def test_host_declared_reads_pass_the_guard_by_exact_name
    @store.unhook!
    @store = Sendproof::Firestore::Store.new(treat_as_read: ["Commit"])
    recorder = preview { |_| @firestore.doc("orders/o").set({ status: "declared" }) }
    assert_nil recorder.blocked, "the host's statement is trusted"
    assert_raises(ArgumentError) { Sendproof::Firestore::Store.new(treat_as_read: ["Comm*"]) }
  end

  def test_a_second_store_is_refused_until_the_first_is_unhooked
    assert_raises(Sendproof::ConfigurationError) { Sendproof::Firestore::Store.new }
    @store.unhook!
    @store = Sendproof::Firestore::Store.new
  end

  def test_the_guard_checks_fail_when_the_hook_is_removed
    @store.unhook!
    recorder = preview { |_| @firestore.doc("orders/unhooked").set({ status: "x" }) }
    assert_nil recorder.blocked, "Without the hook nothing is refused"
    assert_equal ["Commit"], seen, "and the write reaches Firestore"
  end

  def test_discovery_lists_the_store_in_guard_mode
    assert_equal({ system: "firestore", name: "orders", mode: :guard }, @store.describe)
  end

  # Replays what a real SDK sent (spec/data-stores/recordings/firestore.json), request by request,
  # through the interceptor over a fake transport. See that directory's README.
  RECORDINGS = JSON.parse(File.read(File.expand_path("../../../../spec/data-stores/recordings/firestore.json", __dir__))).freeze

  # The generated request class for an RPC name, and a message decoded from the recording's JSON body.
  def message_for(rpc_name, body)
    klass = Google::Cloud::Firestore::V1.const_get("#{rpc_name}Request")
    body ? klass.decode_json(JSON.generate(body), ignore_unknown_fields: true) : klass.new
  end

  # Sends one recorded request the way the gRPC client does: unary and server-streaming calls through the
  # interceptor, with +transport+ standing in for the channel.
  def replay(interceptor, request, transport)
    rpc = request["rpc"]
    message = message_for(rpc.split("/").last, request["rest"]["body"])
    streaming = %w[BatchGetDocuments RunQuery RunAggregationQuery PartitionQuery].include?(rpc.split("/").last)
    call = ->(&send) { streaming ? interceptor.server_streamer(request: message, method: rpc, &send) : interceptor.request_response(request: message, method: rpc, &send) }
    call.call { transport << rpc.split("/").last; :sent }
  end

  def test_the_recorded_requests_are_classified_as_recorded
    interceptor = Sendproof::Firestore::Interceptor.new
    RECORDINGS["recordings"].each do |recording|
      recording["requests"].each do |request|
        expected = request["expect"]
        operation = expected["operation"]
        transport = []
        recorder = preview do |current|
          if expected["kind"] == "write"
            assert_raises(Sendproof::PreviewWriteBlocked, "#{recording['name']}: #{operation}") { replay(interceptor, request, transport) }
          else
            assert_equal :sent, replay(interceptor, request, transport), "#{recording['name']}: #{operation}"
          end
        end
        label = "#{recording['name']}: #{operation}"
        if expected["kind"] == "write"
          assert_empty transport, "#{label} must not reach the transport"
          assert_equal ["firestore", operation], [recorder.blocked.store, recorder.blocked.operation], label
        else
          assert_equal [operation], transport, "#{label} must reach the transport unchanged"
          assert_nil recorder.blocked, label
          expected["kind"] == "read" ? assert_equal(1, db_entries(recorder, operation).length, label) : assert_empty(db_entries(recorder), label)
        end
        outside = []
        replay(interceptor, request, outside)
        assert_equal [operation], outside, "#{label}: outside a Preview every request reaches the transport"
      end
    end
  end

  # The same replay with the hook removed: the write assertions fail, so the test proves the hook is what blocks.
  def test_the_recorded_writes_reach_the_transport_when_the_hook_is_removed
    @store.unhook!
    interceptor = Sendproof::Firestore::Interceptor.new
    writes = RECORDINGS["recordings"].flat_map { |recording| recording["requests"] }.select { |request| request["expect"]["kind"] == "write" }
    refute_empty writes
    writes.each do |request|
      transport = []
      recorder = preview { |_| replay(interceptor, request, transport) }
      assert_nil recorder.blocked, request["expect"]["operation"]
      assert_equal [request["expect"]["operation"]], transport
    end
  end
end
