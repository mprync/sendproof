# frozen_string_literal: true

require "mongo"
require "sendproof"

module Sendproof
  # Sendproof Preview and write guard for MongoDB (spec/data-stores.md "MongoDB in Preview") over the
  # +mongo+ Ruby driver.
  #
  # On a replica set or sharded cluster a Preview runs every command in one transaction that is aborted
  # after the handler, and reports document changes. On a standalone server MongoDB can't run
  # transactions, so the store runs in +guard+ mode like Redis: reads run and the first write blocks the
  # Preview.
  #
  # - Mongoid 9: {Sendproof::Mongoid::Store}, which makes the Preview session ambient for Mongoid.
  # - The plain driver: {Sendproof::Mongo::Store}, whose +client+ is a guarded client with the driver's API.
  #
  # Require it explicitly: +require "sendproof/mongo"+ (or +"sendproof/mongoid"+).
  #
  # *Coverage.* Only hooked clients are covered. Command monitoring backs both up and refuses, before
  # the command is sent, any write during a Preview that doesn't carry the Preview's session and
  # transaction, so a rollback is never claimed for a write that escaped.
  module Mongo
    autoload :Engine, "sendproof/mongo/engine"
    autoload :Guarded, "sendproof/mongo/guarded"
    autoload :Plain, "sendproof/mongo/plain"
    autoload :Store, "sendproof/mongo/store"
    autoload :Subscriber, "sendproof/mongo/subscriber"

    # The reason a standalone server, or any reply the binding doesn't recognize, runs in +guard+ mode.
    STANDALONE_REASON = "Preview unavailable: this MongoDB server doesn't support transactions"

    # The reason when the detection +hello+ couldn't be sent or answered: whether the server supports
    # transactions is unknown, so the store runs in +guard+ mode for now and asks again next time.
    UNREACHABLE_REASON = "Preview unavailable: couldn't reach MongoDB to check whether it supports transactions, " \
                         "so this Preview runs in guard mode"

    # The reason for a command MongoDB refuses inside a transaction.
    def self.refused_reason(operation) = "Preview unavailable: MongoDB can't run #{operation} inside a transaction"
  end
end
