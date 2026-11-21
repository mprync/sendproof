# frozen_string_literal: true

require "active_record"
require "testbench"

module TestBench
  # ActiveRecord persistence provider: real SQL transactions, rolled back after every preview.
  #
  #   config.test_bench.use TestBench::ActiveRecord::Provider.new
  #
  # Coverage is explicit. The transaction encloses every statement the handler runs on the
  # enrolled connections, so the database is unchanged afterwards. The *diff* comes from model
  # callbacks, so it lists what +save+, +update+ and +destroy+ did. Writes that skip callbacks
  # (+update_all+, +delete_all+, +insert_all+, +touch+, raw SQL, triggers) are rolled back but
  # never synthesized into before/after rows; the preview logs a warning when it sees them.
  module ActiveRecord
    autoload :Observation, "testbench/active_record/observation"
    autoload :Provider, "testbench/active_record/provider"
    autoload :Session, "testbench/active_record/session"
    autoload :SqlSubscriber, "testbench/active_record/sql_subscriber"
    autoload :Tracker, "testbench/active_record/tracker"
    autoload :Tracking, "testbench/active_record/tracking"

    # Hooks the model callbacks and the SQL subscriber into ActiveRecord. Idempotent.
    def self.install!
      return if @installed

      @installed = true
      ::ActiveRecord::Base.include(Tracking)
      SqlSubscriber.subscribe
    end
  end
end

TestBench::ActiveRecord.install!
