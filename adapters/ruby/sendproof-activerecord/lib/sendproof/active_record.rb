# frozen_string_literal: true

require "active_record"
require "sendproof"

module Sendproof
  # ActiveRecord persistence provider: real SQL transactions, rolled back after every preview.
  #
  #   config.sendproof.use Sendproof::ActiveRecord::Provider.new
  #
  # Coverage is explicit. The transaction encloses every statement the handler runs on the
  # enrolled connections, so the database is unchanged afterwards. The *diff* comes from model
  # callbacks, so it lists what +save+, +update+ and +destroy+ did. Writes that skip callbacks
  # (+update_all+, +delete_all+, +insert_all+, +touch+, raw SQL, triggers) are rolled back but
  # never synthesized into before/after rows; the preview logs a warning when it sees them.
  module ActiveRecord
    autoload :InlinedBinds, "sendproof/active_record/inlined_binds"
    autoload :Observation, "sendproof/active_record/observation"
    autoload :Provider, "sendproof/active_record/provider"
    autoload :Session, "sendproof/active_record/session"
    autoload :SqlSubscriber, "sendproof/active_record/sql_subscriber"
    autoload :Tracker, "sendproof/active_record/tracker"
    autoload :Tracking, "sendproof/active_record/tracking"
    autoload :TransactionGuard, "sendproof/active_record/transaction_guard"
    autoload :Turns, "sendproof/active_record/turns"

    # Hooks the model callbacks and the SQL subscriber into ActiveRecord. Idempotent.
    def self.install!
      return if @installed

      @installed = true
      ::ActiveRecord::Base.include(Tracking)
      ::ActiveRecord::ConnectionAdapters::AbstractAdapter.prepend(TransactionGuard)
      ::ActiveRecord::ConnectionAdapters::AbstractAdapter.prepend(InlinedBinds)
      SqlSubscriber.subscribe
    end
  end
end

Sendproof::ActiveRecord.install!
