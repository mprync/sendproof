# frozen_string_literal: true

require "minitest/autorun"
require "tmpdir"
require "sendproof/active_record"

# A real database, so a second connection can check what was durably committed: a SQLite file by default,
# or the MySQL or PostgreSQL server the conformance runner provisions when BENCH_DATABASE=mysql or postgresql
# (see bin/test-mysql and bin/test-postgresql).
MYSQL = ENV["BENCH_DATABASE"] == "mysql"
POSTGRESQL = ENV["BENCH_DATABASE"] == "postgresql"
if MYSQL
  ActiveRecord::Base.establish_connection(url: ENV.fetch("BENCH_DATABASE_URL").sub(/\Amysql:/, "trilogy:"), pool: 12)
elsif POSTGRESQL
  ActiveRecord::Base.establish_connection(url: ENV.fetch("BENCH_DATABASE_URL").sub(/\Apostgres(ql)?:/, "postgresql:"),
                                          pool: 12)
else
  DIRECTORY = Dir.mktmpdir("sendproof-ar-")
  # Minitest runs at exit, so clean up after it rather than in a competing at_exit hook.
  Minitest.after_run { FileUtils.remove_entry(DIRECTORY, true) }
  ActiveRecord::Base.establish_connection(adapter: "sqlite3", database: File.join(DIRECTORY, "test.sqlite3"),
                                          timeout: 5000, pool: 5)
end
ActiveRecord::Schema.verbose = false
ActiveRecord::Schema.define do
  create_table :items, id: false, force: true do |t|
    t.string :id, null: false, primary_key: true
    t.string :name, null: false
    t.string :password_hash
    t.timestamps null: true
  end
  create_table :memberships, primary_key: %i[org_id user_id], force: true do |t|
    t.integer :org_id, null: false
    t.integer :user_id, null: false
    t.string :role
  end
end

class Item < ActiveRecord::Base
  self.primary_key = "id"
  COMMITS = []
  after_commit { COMMITS << id }
end

class Membership < ActiveRecord::Base
  self.primary_key = %i[org_id user_id]
end

module ProviderHelpers
  Context = Struct.new(:env, :request, :config)

  def setup
    Item.delete_all
    Membership.delete_all
    Item::COMMITS.clear
  end

  # Reads on another connection, so only committed data is visible.
  def durable(&block)
    Thread.new { ActiveRecord::Base.connection_pool.with_connection(&block) }.value
  end

  def durable_items = durable { Item.order(:id).pluck(:id) }

  # The recorder of the last {#preview}, for its fault and blocked marks.
  attr_reader :recorder

  # Runs the block as a request handler inside a preview, then rolls back like the transport does.
  # @return [Array(Sendproof::Provider::PreviewSession, Sendproof::Recorder::Snapshot)]
  def preview(provider = Sendproof::ActiveRecord::Provider.new, include_values: true)
    recorder = Sendproof::Recorder.new(rollback: true, include_sql_values: include_values)
    @recorder = recorder
    session = nil
    snapshot = nil
    Sendproof::Capture.with(recorder) do
      session = provider.begin_preview(Context.new)
      begin
        yield
        # The transport rolls back whether or not the handler failed, and always closes the session.
      ensure
        begin
          session.rollback!
          session.finalize_capture(recorder)
          snapshot = recorder.finish
        ensure
          session.close
        end
      end
    end
    [session, snapshot]
  end
end
