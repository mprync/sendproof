# frozen_string_literal: true

require "set"

module Sendproof
  module Redis
    # What a +Db+ log entry shows of a Redis command: its name, its key arguments as written, and
    # every other argument as +?+ (+SET session:42 ?+). Values never appear. A command this table
    # doesn't know shows no keys, so an unknown command can't leak an argument.
    module Commands
      # Commands whose first argument is the key (or the index or channel it works on).
      FIRST = %w[
        GET SET SETEX PSETEX SETNX GETSET GETDEL GETEX APPEND STRLEN INCR DECR INCRBY DECRBY INCRBYFLOAT SETRANGE GETRANGE
        SUBSTR SETBIT GETBIT BITCOUNT BITPOS BITFIELD BITFIELD_RO LCS EXPIRE PEXPIRE EXPIREAT PEXPIREAT EXPIRETIME PEXPIRETIME
        TTL PTTL PERSIST TYPE DUMP RESTORE SORT SORT_RO
        HGET HSET HMGET HMSET HGETALL HDEL HEXISTS HINCRBY HINCRBYFLOAT HKEYS HVALS HLEN HSETNX HSTRLEN HRANDFIELD HSCAN
        HEXPIRE HPEXPIRE HTTL HPTTL HPERSIST
        LPUSH RPUSH LPOP RPOP LLEN LRANGE LINDEX LSET LTRIM LREM LINSERT LPUSHX RPUSHX LPOS
        SADD SREM SMEMBERS SISMEMBER SMISMEMBER SCARD SPOP SRANDMEMBER SSCAN
        ZADD ZREM ZRANGE ZRANGEBYSCORE ZREVRANGE ZREVRANGEBYSCORE ZCARD ZSCORE ZMSCORE ZRANK ZREVRANK ZINCRBY ZCOUNT ZLEXCOUNT
        ZRANGEBYLEX ZREVRANGEBYLEX ZREMRANGEBYRANK ZREMRANGEBYSCORE ZREMRANGEBYLEX ZPOPMIN ZPOPMAX ZSCAN ZRANDMEMBER
        XADD XLEN XRANGE XREVRANGE XDEL XTRIM XACK XAUTOCLAIM XCLAIM XPENDING XGROUP
        PFADD GEOADD GEOPOS GEODIST GEOHASH GEOSEARCH GEORADIUS GEORADIUS_RO GEORADIUSBYMEMBER GEORADIUSBYMEMBER_RO
        PUBLISH SPUBLISH
        JSON.GET JSON.SET JSON.DEL JSON.MGET JSON.TYPE JSON.NUMINCRBY JSON.STRAPPEND JSON.STRLEN JSON.ARRAPPEND JSON.ARRLEN
        JSON.OBJKEYS JSON.OBJLEN JSON.ARRINDEX JSON.RESP JSON.TOGGLE JSON.CLEAR
        TS.ADD TS.GET TS.RANGE TS.REVRANGE TS.CREATE TS.INCRBY TS.DECRBY TS.INFO
        FT.SEARCH FT.AGGREGATE FT.INFO FT.EXPLAIN
      ].to_set.freeze

      # Commands where every argument is a key.
      ALL = %w[DEL EXISTS UNLINK TOUCH MGET WATCH PFCOUNT SINTER SUNION SDIFF SINTERSTORE SUNIONSTORE SDIFFSTORE PFMERGE
               RENAME RENAMENX COPY LMOVE SMOVE RPOPLPUSH SUNIONSTORE].to_set.freeze

      # Commands that alternate key and value.
      ALTERNATE = %w[MSET MSETNX].to_set.freeze

      # Commands whose every argument but the last (a timeout) is a key.
      ALL_BUT_LAST = %w[BLPOP BRPOP BLMOVE BRPOPLPUSH].to_set.freeze

      # Container commands whose key follows the subcommand: +OBJECT ENCODING key+.
      AFTER_SUBCOMMAND = %w[OBJECT XINFO MEMORY].to_set.freeze

      # Script commands: +EVAL script numkeys key ... arg ...+.
      SCRIPTS = %w[EVAL EVALSHA EVAL_RO EVALSHA_RO FCALL FCALL_RO].to_set.freeze

      module_function

      # @param name [String] the command name
      # @param args [Array<String>] its arguments
      # @return [Array<Integer>] the indexes of +args+ that are keys
      def key_indexes(name, args)
        command = name.to_s.upcase
        if FIRST.include?(command) then args.empty? ? [] : [0]
        elsif ALL.include?(command) then (0...args.length).to_a
        elsif ALTERNATE.include?(command) then (0...args.length).step(2).to_a
        elsif ALL_BUT_LAST.include?(command) then (0...[args.length - 1, 0].max).to_a
        elsif AFTER_SUBCOMMAND.include?(command) then args.length > 1 ? [1] : []
        elsif SCRIPTS.include?(command)
          count = args[1].to_s.match?(/\A\d+\z/) ? args[1].to_i : 0
          (2...[2 + count, args.length].min).to_a
        else []
        end
      end

      # @return [Hash] +:statement+ and, when the command has a key, +:target+
      def describe(name, args)
        keys = key_indexes(name, args)
        shown = args.each_with_index.map { |arg, index| keys.include?(index) ? arg.to_s : "?" }
        description = { statement: [name.to_s.upcase, *shown].join(" ") }
        description[:target] = args[keys.first].to_s unless keys.empty?
        description
      end
    end
  end
end
