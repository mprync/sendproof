# frozen_string_literal: true

require_relative "stores_support"
require "net/http"
require "puma"
require "puma/server"
require "sendproof/elasticsearch"
require "sendproof/opensearch"

# A small search server on a free local port. It records every request that reaches it, so a test can
# prove a refused write was never sent, and answers like Elasticsearch and OpenSearch do (the product
# check on +GET /+, hits for a search, a result for a write). Neither real engine is needed.
class FakeSearchServer
  INFO = JSON.generate(name: "fake", cluster_name: "fake", tagline: "You Know, for Search",
                       version: { number: "8.15.0", distribution: "opensearch", build_flavor: "default" })

  # The path a client's product check asks for, with and without the prefix one test configures.
  INFO_PATHS = ["/", "/proxy", "/proxy/"].freeze

  attr_reader :requests

  def initialize
    @requests = []
    @lock = Mutex.new
    @server = Puma::Server.new(method(:call))
    @server.add_tcp_listener("127.0.0.1", 0)
    @server.run
  end

  def url = "http://127.0.0.1:#{@server.connected_ports.first}"

  def stop = @server.stop(true)

  # Everything the server received except the clients' product checks.
  def received = @lock.synchronize { @requests.reject { |method, path, _| method == "GET" && INFO_PATHS.include?(path) } }

  def call(env)
    body = env["rack.input"].read.to_s
    path = env["PATH_INFO"]
    @lock.synchronize { @requests << [env["REQUEST_METHOD"], path, body] }
    sleep 1 if path.start_with?("/slow")
    reply = case path
            when *INFO_PATHS then INFO
            when /_search\z/ then '{"hits":{"total":{"value":1},"hits":[{"_id":"1","_source":{"title":"A"}}]}}'
            when /_doc\/missing\z/ then return [404, { "content-type" => "application/json" }, ['{"error":{"type":"not_found"},"status":404}']]
            when /_string_error\z/ then return [405, { "content-type" => "application/json" }, ['{"error":"Incorrect HTTP method","status":405}']]
            else '{"result":"updated","updated":1}'
            end
    [200, { "content-type" => "application/json", "x-elastic-product" => "Elasticsearch" }, [reply]]
  end
end

# Behavior shared by both libraries, run against {FakeSearchServer}.
module SearchHookTests
  SECRET = "benchSearchSecret#{SecureRandom.hex(6)}"

  def setup
    @server = FakeSearchServer.new
    @stores = []
  end

  def teardown
    @stores.each(&:unhook!)
    @server.stop
  end

  # Creates a store and remembers it, so a test never leaves one registered.
  def new_store(**options)
    store_class.new(name: "search", **options).tap { |store| @stores << store }
  end

  def sent = @server.received.map { |method, path, _| "#{method} #{path}" }

  def test_a_read_in_a_preview_runs_and_is_logged
    new_store
    client = new_client
    recorder = preview { |_| assert_equal 1, client.search(index: "articles", body: { query: { match_all: {} } })["hits"]["hits"].length }
    assert_nil recorder.blocked
    entry = db_entries(recorder, "search").fetch(0)
    assert_equal system_id, entry[:db][:system]
    assert_equal "articles", entry[:db][:target]
    assert_equal 1, entry[:db][:rowsAffected]
    assert_equal '{"query":{"match_all":{}}}', entry[:db][:statement]
  end

  def test_writes_are_refused_before_they_are_sent
    new_store
    client = new_client
    {
      "index" => -> { client.index(index: "articles", id: "1", body: { title: "x" }) },
      "update" => -> { client.update(index: "articles", id: "1", body: { doc: { title: "y" } }) },
      "delete" => -> { client.delete(index: "articles", id: "1") },
      "bulk" => -> { client.bulk(body: [{ index: { _index: "articles", _id: "1" } }, { title: "x" }]) },
      "update_by_query" => -> { client.update_by_query(index: "articles", body: { script: { source: "ctx._source.hidden = true" } }) },
      "delete_by_query" => -> { client.delete_by_query(index: "articles", body: { query: { match_none: {} } }) },
      "reindex" => -> { client.reindex(body: { source: { index: "a" }, dest: { index: "b" } }) },
      "indices.create" => -> { client.indices.create(index: "other") },
      "put_script" => -> { client.put_script(id: "bump", body: { script: { lang: "painless", source: "1" } }) }
    }.each do |operation, call|
      recorder = assert_blocked_in_preview(system_id, operation) { call.call }
      assert_equal "Preview unavailable: this operation writes to #{display}", recorder.blocked.detail
      assert db_entries(recorder, operation).first[:db][:blocked]
    end
    assert_empty sent, "A refused write must never reach the server"
  end

  def test_post_reads_and_session_requests_are_not_blocked
    new_store
    client = new_client
    recorder = preview do |_|
      client.msearch(body: [{ index: "articles" }, { query: { match_all: {} } }])
      client.count(index: "articles")
      client.perform_request("POST", "/articles/_pit", { keep_alive: "1m" })
      client.perform_request("DELETE", "/_search/scroll", {}, { scroll_id: "x" })
    end
    assert_nil recorder.blocked
    operations = db_entries(recorder).map { |entry| entry[:db][:operation] } - ["GET /"] # the client's product check
    assert_equal %w[msearch count], operations, "pit and scroll handles run unlogged"
    assert_equal 4, sent.length
  end

  def test_sql_is_a_read_only_for_a_single_select
    new_store
    client = new_client
    preview { |_| client.perform_request("POST", sql_path, {}, { query: "SELECT title FROM articles" }) }
    assert_blocked_in_preview(system_id, "sql.query") { client.perform_request("POST", sql_path, {}, { query: "DELETE FROM articles" }) }
    assert_blocked_in_preview(system_id, "sql.query") { client.perform_request("POST", sql_path, {}, { query: "SELECT 1; DELETE FROM articles" }) }
    assert_equal 1, sent.length
  end

  def test_a_client_built_before_the_store_is_guarded
    client = new_client
    new_store
    assert_blocked_in_preview(system_id, "index") { client.index(index: "articles", id: "1", body: { title: "x" }) }
    assert_empty sent
  end

  def test_a_client_built_after_the_store_is_guarded
    new_store
    assert_blocked_in_preview(system_id, "index") { new_client.index(index: "articles", id: "1", body: { title: "x" }) }
    assert_empty sent
  end

  def test_a_rebuilt_connection_stays_guarded
    new_store
    client = new_client
    transport = transport_of(client)
    transport.__rebuild_connections(hosts: transport.hosts, options: transport.options)
    assert_blocked_in_preview(system_id, "delete") { client.delete(index: "articles", id: "1") }
    assert_empty sent
  end

  def test_a_client_that_copies_the_connection_options_is_guarded
    new_store
    copy = new_client(retry_on_failure: 1, request_timeout: 5)
    assert_blocked_in_preview(system_id, "index") { copy.index(index: "articles", id: "1", body: {}) }
    assert_empty sent
  end

  def test_a_path_prefix_is_removed_before_classifying
    new_store
    client = new_client(url: "#{@server.url}/proxy")
    assert_blocked_in_preview(system_id, "bulk") { client.bulk(body: [{ index: { _index: "a", _id: "1" } }, {}]) }
    recorder = preview { |_| client.search(index: "articles", body: {}) }
    assert_nil recorder.blocked
    assert_equal ["POST /proxy/articles/_search"], sent
  end

  def test_a_store_that_is_not_global_guards_only_the_clients_it_was_given
    store = new_store(global: false)
    bare = new_client
    hooked = new_client { |faraday| store.install(faraday) }
    adopted = new_client
    store.hook(adopted)
    preview do |_|
      assert_raises(Sendproof::PreviewWriteBlocked) { hooked.index(index: "articles", id: "1", body: {}) }
      assert_raises(Sendproof::PreviewWriteBlocked) { adopted.index(index: "articles", id: "2", body: {}) }
      bare.index(index: "articles", id: "3", body: {})
    end
    assert_equal ["PUT /articles/_doc/3"], sent, "a client the store was not given is not covered"
  end

  def test_a_second_store_is_refused_until_the_first_is_unhooked
    store = new_store
    assert_raises(Sendproof::ConfigurationError) { store_class.new }
    store.unhook!
    new_store
  end

  def test_a_client_with_a_transport_the_guard_cannot_cover_refuses_the_store_at_startup
    stranger = transport_client_class.new(transport: Object.new)
    error = assert_raises(Sendproof::ConfigurationError) { store_class.new }
    assert_match(/can't guard/, error.message)
    assert_nil Sendproof::Search.store(system_id), "a store that failed to start is not left registered"
  ensure
    # A live client stays visible until the garbage collector runs; give it a transport the guard can cover.
    stranger.transport = transport_client_class.new(url: @server.url).transport if stranger
  end

  def test_a_client_built_later_with_a_transport_the_guard_cannot_cover_fails_closed
    new_store
    built = nil
    assert_raises(Sendproof::ConfigurationError) { built = transport_client_class.new(transport: Object.new) }
    assert_nil built
  end

  def test_a_write_from_a_thread_the_handler_started_is_refused_before_it_is_sent
    new_store
    client = new_client
    recorder = preview do |_|
      Thread.new { assert_raises(Sendproof::PreviewWriteBlocked) { client.index(index: "articles", id: "t", body: {}) } }.join
    end
    assert_equal [system_id, "index"], [recorder.blocked&.store, recorder.blocked&.operation]
    assert_nil recorder.fault
    assert_empty sent, "the unattributed write never reached the server"
    detached = preview { |_| Thread.new { Sendproof.detached { client.index(index: "articles", id: "w", body: {}) } }.join }
    assert_nil detached.blocked
    assert_nil detached.fault
    assert_equal ["PUT /articles/_doc/w"], sent
  end

  # The refusal is not a connection error, so the transport's pool never marks the node dead, never retries
  # the write on another node and never reloads: with two nodes, the reads after it still use both.
  def test_a_refused_write_never_marks_a_node_dead_or_retries
    other = FakeSearchServer.new
    new_store
    client = new_client(url: [@server.url, other.url], retry_on_failure: 3, reload_on_failure: true)
    transport = transport_of(client)
    assert_blocked_in_preview(system_id, "index") { client.index(index: "articles", id: "1", body: {}) }
    assert_empty transport.connections.dead, "a refused write must not take a node out of rotation"
    assert_equal 2, transport.connections.alive.length
    preview { |_| 4.times { client.search(index: "articles", body: {}) } }
    searches = [@server, other].map { |server| server.received.count { |method, path, _| method == "POST" && path.end_with?("_search") } }
    assert_equal [2, 2], searches, "both nodes keep serving reads"
    assert_empty(([@server, other].flat_map(&:received).reject { |_, path, _| path.end_with?("_search") }), "the write was never sent or retried")
  ensure
    other&.stop
  end

  # Some errors carry a string, not an object, as +error+ (a 405, for example). Logging the reply must not
  # turn a request that was already sent into an exception.
  def test_a_reply_whose_error_is_a_string_is_logged_and_returned
    new_store
    client = new_client
    recorder = observe do |_|
      error = assert_raises(StandardError) { client.perform_request("GET", "/articles/_string_error") }
      refute_kind_of TypeError, error
    end
    assert_equal "405", db_entries(recorder, "GET /{}/_string_error").fetch(0)[:db][:error]
  end

  # A body that isn't valid UTF-8 has no statement; it must not stop the request.
  def test_a_body_that_is_not_valid_utf8_is_sent_without_a_statement
    new_store
    client = new_client
    recorder = observe { |_| client.perform_request("POST", "/articles/_doc", {}, "{\"a\":1}\n\xff\xfe".dup.force_encoding("UTF-8")) }
    entry = db_entries(recorder, "index").fetch(0)
    assert_nil entry[:db][:statement]
    assert_equal ["POST /articles/_doc"], sent
  end

  # A timeout that unwinds the handler mid-request propagates as it would without Sendproof, leaves no
  # fault on the Preview, and leaves the client usable.
  def test_a_timeout_during_a_read_propagates_and_leaves_the_guard_working
    new_store
    client = new_client
    recorder = preview { |_| assert_raises(Timeout::Error) { Timeout.timeout(0.2) { client.search(index: "slow", body: {}) } } }
    assert_nil recorder.blocked
    assert_nil recorder.fault
    assert_blocked_in_preview(system_id, "index") { client.index(index: "articles", id: "1", body: {}) }
  end

  def test_send_and_observed_send_are_never_blocked
    new_store
    client = new_client
    client.index(index: "articles", id: "1", body: { title: "x" })
    recorder = observe { |_| client.index(index: "articles", id: "2", body: { title: "y" }) }
    assert_nil recorder.blocked
    assert_equal %w[PUT\ /articles/_doc/1 PUT\ /articles/_doc/2], sent
    assert_equal "index", db_entries(recorder).fetch(0)[:db][:operation], "an observed send traces the write"
  end

  def test_statements_carry_no_values_and_credentials_never_reach_a_capture
    new_store
    client = new_client(url: @server.url.sub("//", "//bench:#{SECRET}@"), headers: { "Authorization" => "ApiKey #{SECRET}" })
    recorder = observe do |_|
      client.bulk(body: [{ index: { _index: "articles", _id: "7" } }, { title: "Private title", password: "hunter2" }])
    end
    statement = db_entries(recorder, "bulk").fetch(0)[:db][:statement]
    assert_equal %({"index":{"_index":"?","_id":"?"}}\n{"title":"?","password":"?"}), statement
    json = JSON.generate(captured(recorder).logs)
    [SECRET, "hunter2", "Private title"].each { |value| refute_includes json, value }
  end

  def test_an_error_reply_is_logged_with_its_type
    new_store
    client = new_client
    recorder = observe { |_| assert_raises(StandardError) { client.get(index: "articles", id: "missing") } }
    entry = db_entries(recorder, "get").fetch(0)
    assert_equal "not_found", entry[:db][:error]
  end

  def test_host_declared_reads_pass_the_guard_by_exact_operation_name
    new_store(treat_as_read: ["POST /{}/_my_plugin_read"])
    client = new_client
    preview { |_| client.perform_request("POST", "/articles/_my_plugin_read", {}, {}) }
    assert_blocked_in_preview(system_id, "POST /{}/_my_plugin_write") { client.perform_request("POST", "/articles/_my_plugin_write", {}, {}) }
    assert_equal ["POST /articles/_my_plugin_read"], sent
  end

  def test_the_guard_checks_fail_when_the_hook_is_removed
    store = new_store
    client = new_client
    store.unhook!
    recorder = preview { |_| client.index(index: "articles", id: "unhooked", body: { title: "x" }) }
    assert_nil recorder.blocked, "Without the hook nothing is refused"
    assert_equal ["PUT /articles/_doc/unhooked"], sent, "and the write reaches the server"
  end

  def test_discovery_lists_the_store_in_guard_mode
    assert_equal({ system: system_id, name: "search", mode: :guard }, new_store.describe)
  end

  def test_a_store_name_is_a_label_never_a_url
    assert_raises(ArgumentError) { store_class.new(name: "http://user:pw@host:9200") }
  end
end

class ElasticsearchHookTest < Minitest::Test
  include StoreHelpers
  include SearchHookTests

  def store_class = Sendproof::Elasticsearch::Store
  def system_id = "elasticsearch"
  def display = "Elasticsearch"
  def sql_path = "/_sql"
  def transport_client_class = Elastic::Transport::Client
  def transport_of(client) = client.instance_variable_get(:@transport).transport

  def new_client(url: @server.url, **options, &block)
    ::Elasticsearch::Client.new(url: url, **options, &block)
  end
end

class OpenSearchFakeHookTest < Minitest::Test
  include StoreHelpers
  include SearchHookTests

  def store_class = Sendproof::OpenSearch::Store
  def system_id = "opensearch"
  def display = "OpenSearch"
  def sql_path = "/_plugins/_sql"
  def transport_client_class = ::OpenSearch::Transport::Client
  def transport_of(client) = client.transport.transport

  def new_client(url: @server.url, **options, &block)
    ::OpenSearch::Client.new(url: url, **options, &block)
  end
end

# The OpenSearch hook against the compose OpenSearch (docker compose -f tests/conformance/compose.yml
# --profile heavy-stores up -d --wait opensearch): a refused write is checked by a client the hook never saw.
class OpenSearchHookTest < Minitest::Test
  include StoreHelpers
  include Rack::Test::Methods

  def setup
    needs(:opensearch)
    @index = unique("tb")
    @store = Sendproof::OpenSearch::Store.new(name: "search")
    @client = ::OpenSearch::Client.new(url: SERVERS[:opensearch])
    @reader = new_reader
    @reader.indices.create(index: @index, body: { mappings: { properties: { title: { type: "keyword" }, views: { type: "integer" } } } })
    @reader.index(index: @index, id: "seeded", body: { title: "Seeded", views: 3 }, refresh: true)
  end

  def teardown
    @store&.unhook!
    @reader&.indices&.delete(index: @index, ignore_unavailable: true)
  end

  # A client the hook never saw, made while the store is unhooked would be unguarded, so the reader
  # is built before the store exists in a scratch process-free way: it bypasses the middleware by
  # talking Net::HTTP instead. What it returns is what is really stored.
  def new_reader
    Class.new do
      def initialize(base, index) = (@base = URI(base); @index = index)

      def indices = self

      def create(index:, body:) = call(Net::HTTP::Put, "/#{index}", body)

      def delete(index:, **) = call(Net::HTTP::Delete, "/#{index}")

      def index(index:, id:, body:, refresh: false) = call(Net::HTTP::Put, "/#{index}/_doc/#{id}?refresh=#{refresh}", body)

      def get(id)
        reply = call(Net::HTTP::Get, "/#{@index}/_doc/#{id}")
        reply["found"] ? reply["_source"] : nil
      end

      private

      def call(klass, path, body = nil)
        request = klass.new(path, "content-type" => "application/json")
        request.body = JSON.generate(body) if body
        response = Net::HTTP.start(@base.host, @base.port) { |http| http.request(request) }
        JSON.parse(response.body)
      end
    end.new(SERVERS[:opensearch], @index)
  end

  def article(id) = @reader.get(id)

  def test_a_read_in_a_preview_runs_against_the_real_server
    recorder = preview do |_|
      hit = @client.search(index: @index, body: { query: { ids: { values: ["seeded"] } }, size: 1 })["hits"]["hits"].first
      assert_equal "Seeded", hit["_source"]["title"]
    end
    assert_nil recorder.blocked
    entry = db_entries(recorder, "search").fetch(0)
    assert_equal @index, entry[:db][:target]
    assert_equal 1, entry[:db][:rowsAffected]
  end

  def test_an_update_is_refused_before_it_reaches_opensearch
    assert_blocked_in_preview("opensearch", "update") do
      @client.update(index: @index, id: "blocked", body: { script: { source: "ctx._source.views += 1" }, upsert: { title: "Untitled", views: 1 } },
                     refresh: true)
    end
    assert_nil article("blocked"), "the update must not reach OpenSearch"
  end

  def test_update_by_query_and_delete_are_refused
    assert_blocked_in_preview("opensearch", "update_by_query") do
      @client.update_by_query(index: @index, body: { query: { ids: { values: ["seeded"] } }, script: { source: "ctx._source.hidden = true" } },
                              refresh: true)
    end
    assert_blocked_in_preview("opensearch", "delete") { @client.delete(index: @index, id: "seeded", refresh: true) }
    assert_equal({ "title" => "Seeded", "views" => 3 }, article("seeded"))
  end

  def test_the_guard_checks_fail_when_the_hook_is_removed
    @store.unhook!
    recorder = preview { |_| @client.index(index: @index, id: "unhooked", body: { title: "x", views: 1 }, refresh: true) }
    assert_nil recorder.blocked, "Without the hook nothing is refused"
    assert_equal "x", article("unhooked")["title"], "and the write reaches OpenSearch"
  end

  # Through the real Rack transport: the handler swallows the refusal and answers 200, the Preview answers 409.
  def app
    client = @client
    index = @index
    config = build_config
    config.use(CoreHelpers::FakeProvider.new)
    config.data_store(@store)
    config.preview_operations = [%w[POST /articles/{id}/touch]]
    config.identity = ->(request) { { name: "a", subject: "a" } if request.get_header("HTTP_X_USER") }
    application = lambda do |env|
      request = Rack::Request.new(env)
      Sendproof::Handler.around(env, request:, eligible: true) do
        begin
          client.update(index: index, id: "rack", body: { doc: { title: "x" }, doc_as_upsert: true })
        rescue Sendproof::PreviewWriteBlocked
          nil
        end
        [200, { "content-type" => "application/json" }, ['{"swallowed":true}']]
      end
    end
    Rack::Builder.app { use Sendproof::Middleware, config; run application }
  end

  def test_a_blocked_preview_answers_409_through_the_transport_even_when_the_handler_swallows_the_error
    post "/sendproof/_preview/articles/rack/touch", "{}", { "HTTP_PREFER" => "tx=rollback", "CONTENT_TYPE" => "application/json", "HTTP_X_USER" => "a" }
    assert_equal 409, last_response.status, last_response.body
    assert_nil last_response["preference-applied"]
    body = JSON.parse(last_response.body)
    assert_equal({ "store" => "opensearch", "operation" => "update", "rolledBack" => false }, body.slice("store", "operation", "rolledBack"))
    assert_nil article("rack")
  end
end
