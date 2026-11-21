# frozen_string_literal: true

require "redis-client"
require "sendproof"

module Sendproof
  # Sendproof write guard for Redis (spec/data-stores.md, +guard+ mode), for +redis-client+ and the
  # +redis+ 5 gem built on it, including Rails' +RedisCacheStore+.
  #
  #   store = Sendproof::Redis::Store.new(name: "cache")   # registers redis-client middleware
  #   config.sendproof.data_store store
  #
  # Require it explicitly: +require "sendproof/redis"+. It needs no Redis server.
  module Redis
    autoload :Commands, "sendproof/redis/commands"
    autoload :Store, "sendproof/redis/store"
  end
end
