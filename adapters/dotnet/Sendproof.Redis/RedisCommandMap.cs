using Sendproof.AspNetCore;
using StackExchange.Redis;

namespace Sendproof.Redis;

/// <summary>
/// Maps StackExchange.Redis methods to the Redis command each sends, so the shared classification table decides
/// whether it is a read. A method the map doesn't know is classified as the upper-cased method name, which the table
/// doesn't list, so it is a write: the guard fails closed when the library adds a method.
/// </summary>
internal static class RedisCommandMap
{
    /// <summary>A Redis command, and the subcommand of a container command such as <c>OBJECT ENCODING</c>.</summary>
    internal readonly record struct Command(string Name, string? Sub = null);

    // Reads and writes by method name, without the Async suffix. The classification itself comes from the table in
    // spec/data-stores/redis.json; the names here only say which command a method sends.
    private static readonly Dictionary<string, Command> Commands = new(StringComparer.Ordinal)
    {
        // Strings
        ["StringGet"] = new("GET"), ["StringGetRange"] = new("GETRANGE"), ["StringLength"] = new("STRLEN"),
        ["StringGetBit"] = new("GETBIT"), ["StringBitCount"] = new("BITCOUNT"), ["StringBitPosition"] = new("BITPOS"),
        ["StringGetWithExpiry"] = new("GET"), ["StringLongestCommonSubsequence"] = new("LCS"),
        ["StringLongestCommonSubsequenceLength"] = new("LCS"), ["StringLongestCommonSubsequenceWithMatches"] = new("LCS"),
        ["StringSet"] = new("SET"), ["StringSetAndGet"] = new("SET"), ["StringSetRange"] = new("SETRANGE"),
        ["StringAppend"] = new("APPEND"), ["StringGetDelete"] = new("GETDEL"), ["StringGetSetExpiry"] = new("GETEX"),
        ["StringSetBit"] = new("SETBIT"), ["StringBitOperation"] = new("BITOP"),
        ["StringDecrement"] = new("DECRBY"), ["StringIncrement"] = new("INCRBY"),
        ["StringGetSet"] = new("GETSET"), ["StringSetAndGetDelete"] = new("SET"),
        // Keys
        ["KeyExists"] = new("EXISTS"), ["KeyTimeToLive"] = new("TTL"), ["KeyExpireTime"] = new("PEXPIRETIME"),
        ["KeyType"] = new("TYPE"), ["KeyEncoding"] = new("OBJECT", "ENCODING"), ["KeyFrequency"] = new("OBJECT", "FREQ"),
        ["KeyIdleTime"] = new("OBJECT", "IDLETIME"), ["KeyRandom"] = new("RANDOMKEY"), ["KeyDump"] = new("DUMP"),
        ["KeyTouch"] = new("TOUCH"), ["KeyDelete"] = new("DEL"), ["KeyExpire"] = new("EXPIRE"),
        ["KeyRename"] = new("RENAME"), ["KeyMove"] = new("MOVE"), ["KeyCopy"] = new("COPY"),
        ["KeyMigrate"] = new("MIGRATE"), ["KeyRestore"] = new("RESTORE"),
        // Hashes
        ["HashGet"] = new("HGET"), ["HashGetAll"] = new("HGETALL"), ["HashKeys"] = new("HKEYS"), ["HashValues"] = new("HVALS"),
        ["HashLength"] = new("HLEN"), ["HashExists"] = new("HEXISTS"), ["HashStringLength"] = new("HSTRLEN"),
        ["HashScan"] = new("HSCAN"), ["HashScanNoValues"] = new("HSCAN"), ["HashRandomField"] = new("HRANDFIELD"),
        ["HashRandomFields"] = new("HRANDFIELD"), ["HashRandomFieldsWithValues"] = new("HRANDFIELD"),
        ["HashFieldGetTimeToLive"] = new("HPTTL"), ["HashFieldGetExpireDateTime"] = new("HPEXPIRETIME"),
        ["HashSet"] = new("HSET"), ["HashDelete"] = new("HDEL"), ["HashIncrement"] = new("HINCRBY"),
        ["HashDecrement"] = new("HINCRBY"), ["HashFieldExpire"] = new("HEXPIRE"), ["HashFieldPersist"] = new("HPERSIST"),
        ["HashFieldGetAndDelete"] = new("HGETDEL"), ["HashFieldGetAndSetExpiry"] = new("HGETEX"),
        // Lists
        ["ListGetByIndex"] = new("LINDEX"), ["ListLength"] = new("LLEN"), ["ListRange"] = new("LRANGE"),
        ["ListPosition"] = new("LPOS"), ["ListPositions"] = new("LPOS"),
        ["ListLeftPush"] = new("LPUSH"), ["ListRightPush"] = new("RPUSH"), ["ListLeftPop"] = new("LPOP"),
        ["ListRightPop"] = new("RPOP"), ["ListInsertBefore"] = new("LINSERT"), ["ListInsertAfter"] = new("LINSERT"),
        ["ListRemove"] = new("LREM"), ["ListSetByIndex"] = new("LSET"), ["ListTrim"] = new("LTRIM"),
        ["ListMove"] = new("LMOVE"),
        // Sets
        ["SetContains"] = new("SISMEMBER"), ["SetLength"] = new("SCARD"), ["SetMembers"] = new("SMEMBERS"),
        ["SetScan"] = new("SSCAN"), ["SetRandomMember"] = new("SRANDMEMBER"), ["SetRandomMembers"] = new("SRANDMEMBER"),
        ["SetIntersectionLength"] = new("SINTERCARD"), ["SetAdd"] = new("SADD"), ["SetRemove"] = new("SREM"),
        ["SetPop"] = new("SPOP"), ["SetMove"] = new("SMOVE"),
        // Sorted sets
        ["SortedSetLength"] = new("ZCARD"), ["SortedSetLengthByValue"] = new("ZLEXCOUNT"), ["SortedSetRank"] = new("ZRANK"),
        ["SortedSetScore"] = new("ZSCORE"), ["SortedSetScores"] = new("ZMSCORE"),
        ["SortedSetRangeByRank"] = new("ZRANGE"), ["SortedSetRangeByRankWithScores"] = new("ZRANGE"),
        ["SortedSetRangeByScore"] = new("ZRANGEBYSCORE"), ["SortedSetRangeByScoreWithScores"] = new("ZRANGEBYSCORE"),
        ["SortedSetRangeByValue"] = new("ZRANGEBYLEX"), ["SortedSetIntersectionLength"] = new("ZINTERCARD"),
        ["SortedSetScan"] = new("ZSCAN"), ["SortedSetRandomMember"] = new("ZRANDMEMBER"),
        ["SortedSetRandomMembers"] = new("ZRANDMEMBER"), ["SortedSetRandomMembersWithScores"] = new("ZRANDMEMBER"),
        ["SortedSetAdd"] = new("ZADD"), ["SortedSetUpdate"] = new("ZADD"), ["SortedSetRemove"] = new("ZREM"),
        ["SortedSetIncrement"] = new("ZINCRBY"), ["SortedSetDecrement"] = new("ZINCRBY"), ["SortedSetPop"] = new("ZPOPMIN"),
        ["SortedSetRemoveRangeByRank"] = new("ZREMRANGEBYRANK"), ["SortedSetRemoveRangeByScore"] = new("ZREMRANGEBYSCORE"),
        ["SortedSetRemoveRangeByValue"] = new("ZREMRANGEBYLEX"), ["SortedSetCombineAndStore"] = new("ZUNIONSTORE"),
        ["SortedSetRangeAndStore"] = new("ZRANGESTORE"),
        // Streams
        ["StreamRead"] = new("XREAD"), ["StreamRange"] = new("XRANGE"), ["StreamLength"] = new("XLEN"),
        ["StreamInfo"] = new("XINFO", "STREAM"), ["StreamGroupInfo"] = new("XINFO", "GROUPS"),
        ["StreamConsumerInfo"] = new("XINFO", "CONSUMERS"), ["StreamPending"] = new("XPENDING"),
        ["StreamPendingMessages"] = new("XPENDING"), ["StreamAdd"] = new("XADD"), ["StreamDelete"] = new("XDEL"),
        ["StreamTrim"] = new("XTRIM"), ["StreamAcknowledge"] = new("XACK"), ["StreamCreateConsumerGroup"] = new("XGROUP"),
        ["StreamDeleteConsumerGroup"] = new("XGROUP"), ["StreamDeleteConsumer"] = new("XGROUP"),
        ["StreamConsumerGroupSetPosition"] = new("XGROUP"), ["StreamReadGroup"] = new("XREADGROUP"),
        ["StreamClaim"] = new("XCLAIM"), ["StreamClaimIdsOnly"] = new("XCLAIM"), ["StreamAutoClaim"] = new("XAUTOCLAIM"),
        ["StreamAutoClaimIdsOnly"] = new("XAUTOCLAIM"),
        // HyperLogLog, geo, scripts, locks, sort
        ["HyperLogLogLength"] = new("PFCOUNT"), ["HyperLogLogAdd"] = new("PFADD"), ["HyperLogLogMerge"] = new("PFMERGE"),
        ["GeoDistance"] = new("GEODIST"), ["GeoHash"] = new("GEOHASH"), ["GeoPosition"] = new("GEOPOS"),
        ["GeoSearch"] = new("GEOSEARCH"), ["GeoRadius"] = new("GEORADIUS"), ["GeoAdd"] = new("GEOADD"),
        ["GeoRemove"] = new("ZREM"), ["GeoSearchAndStore"] = new("GEOSEARCHSTORE"),
        ["ScriptEvaluate"] = new("EVAL"), ["ScriptEvaluateReadOnly"] = new("EVAL_RO"),
        ["LockQuery"] = new("GET"), ["LockTake"] = new("SET"), ["LockRelease"] = new("DEL"), ["LockExtend"] = new("PEXPIRE"),
        ["Sort"] = new("SORT"), ["SortAndStore"] = new("SORT"), ["Publish"] = new("PUBLISH"),
        ["Subscribe"] = new("SUBSCRIBE"), ["Unsubscribe"] = new("UNSUBSCRIBE"), ["UnsubscribeAll"] = new("UNSUBSCRIBE"),
        ["Ping"] = new("PING"),
        // Server
        ["DatabaseSize"] = new("DBSIZE"), ["Keys"] = new("KEYS"), ["Info"] = new("INFO"), ["InfoRaw"] = new("INFO"),
        ["Time"] = new("TIME"), ["LastSave"] = new("LASTSAVE"), ["ClientList"] = new("CLIENT", "LIST"),
        ["ConfigGet"] = new("CONFIG", "GET"), ["ConfigSet"] = new("CONFIG", "SET"), ["FlushDatabase"] = new("FLUSHDB"),
        ["FlushAllDatabases"] = new("FLUSHALL"),
    };

    // Container commands, whose first argument is a subcommand (OBJECT ENCODING, CLIENT LIST): the ones the table lists
    // with a vertical bar, and the common ones it doesn't, which are writes.
    private static readonly HashSet<string> Containers = new(
        StoreTables.Redis.Read.Concat(StoreTables.Redis.Session).Where(key => key.Contains('|')).Select(key => key[..key.IndexOf('|')])
            .Concat(["CLIENT", "CONFIG", "OBJECT", "MEMORY", "XINFO", "COMMAND", "SCRIPT", "FUNCTION", "CLUSTER", "ACL", "LATENCY", "MODULE", "PUBSUB", "SLOWLOG", "XGROUP"]),
        StringComparer.Ordinal);

    /// <summary>Methods that send no command: they describe the connection or hand back a guarded batch.</summary>
    internal static bool IsNotACommand(string method) => method is "IsConnected" or "IdentifyEndpoint" or "Dispose" or "DisposeAsync" or
        "AddCondition" or "SubscribedEndpoint" or "WaitAll" or "Wait" or "TryWait";

    /// <summary>Whether a method returns a batch or transaction that must stay guarded.</summary>
    internal static bool CreatesBatch(string method) => method is "CreateBatch" or "CreateTransaction";

    /// <summary>
    /// Names the Redis command a method call sends. <paramref name="arguments"/> are the call's arguments, read only
    /// to tell <c>INCR</c> from <c>INCRBY</c>, <c>GET</c> from <c>MGET</c> and the set operation of a combine; the
    /// answer never depends on a value for classification beyond the command name.
    /// </summary>
    internal static Command Resolve(string method, object?[] arguments)
    {
        var name = method.EndsWith("Async", StringComparison.Ordinal) ? method[..^5] : method;
        if (name is "Execute")
        {
            // Execute(command, args...): the command is the first argument, a container command's subcommand the next.
            var command = Convert.ToString(arguments.FirstOrDefault(), System.Globalization.CultureInfo.InvariantCulture) ?? "";
            var rest = arguments.Length > 1 ? arguments[1] : null;
            object? first = rest switch
            {
                object?[] list when list.Length > 0 => list[0],
                System.Collections.IEnumerable items and not string => items.Cast<object?>().FirstOrDefault(),
                _ => null
            };
            var upper = command.ToUpperInvariant();
            return new Command(upper, first is null or RedisKey || !Containers.Contains(upper)
                ? null
                : Convert.ToString(first, System.Globalization.CultureInfo.InvariantCulture));
        }

        if (name is "SetCombine" or "SortedSetCombine" or "SortedSetCombineWithScores")
        {
            var operation = arguments.OfType<SetOperation>().Cast<SetOperation?>().FirstOrDefault();
            var prefix = name.StartsWith("Sorted", StringComparison.Ordinal) ? "Z" : "S";
            return new Command(operation switch
            {
                SetOperation.Union => prefix + "UNION",
                SetOperation.Intersect => prefix + "INTER",
                SetOperation.Difference => prefix + "DIFF",
                _ => prefix + "COMBINE"
            });
        }

        if (name is "SetCombineAndStore")
        {
            return new Command(arguments.OfType<SetOperation>().FirstOrDefault() switch
            {
                SetOperation.Union => "SUNIONSTORE",
                SetOperation.Intersect => "SINTERSTORE",
                _ => "SDIFFSTORE"
            });
        }

        if (name is "SetContains" && arguments.Any(argument => argument is RedisValue[]))
        {
            return new Command("SMISMEMBER");
        }

        if (name is "StringGet" && arguments.Any(argument => argument is RedisKey[]))
        {
            return new Command("MGET");
        }

        if (name is "StringSet" && arguments.Any(argument => argument is KeyValuePair<RedisKey, RedisValue>[]))
        {
            return new Command("MSET");
        }

        if (name is "StringIncrement" or "StringDecrement")
        {
            var by = arguments.Skip(1).FirstOrDefault();
            var isDouble = by is double;
            var isOne = by is long one && one == 1 || by is null;
            var decrement = name == "StringDecrement";
            return new Command(isDouble ? "INCRBYFLOAT" : decrement ? isOne ? "DECR" : "DECRBY" : isOne ? "INCR" : "INCRBY");
        }

        if (name is "HashIncrement" or "HashDecrement" && arguments.Any(argument => argument is double))
        {
            return new Command("HINCRBYFLOAT");
        }

        return Commands.TryGetValue(name, out var known) ? known : new Command(name.ToUpperInvariant());
    }

    /// <summary>
    /// The sanitized command text: the command name, then its key arguments, then one <c>?</c> for every other value
    /// (so <c>SET session:42 ?</c>). A value never appears. The first key is the entry's target.
    /// </summary>
    internal static (string Statement, string? Target) Describe(Command command, object?[] arguments, bool keysKnown)
    {
        var parts = new List<string> { command.Sub is null ? command.Name : $"{command.Name} {command.Sub}" };
        string? target = null;
        foreach (var argument in arguments)
        {
            switch (argument)
            {
                case RedisKey key when keysKnown:
                    target ??= key.ToString();
                    parts.Add(key.ToString());
                    break;
                case RedisKey[] keys when keysKnown:
                    foreach (var key in keys)
                    {
                        target ??= key.ToString();
                        parts.Add(key.ToString());
                    }

                    break;
                case CommandFlags or CancellationToken or Enum:
                    break;
                case null:
                    break;
                default:
                    parts.Add("?");
                    break;
            }
        }

        return (string.Join(' ', parts), target);
    }
}
