//! What a `Db` log entry shows of a Redis command: its name, its key arguments, and `?` for
//! everything else, so a value never appears in a capture.

/// The argument positions (0 is the first argument after the command name) that are keys.
///
/// Only commands whose key positions are known show any key. An unknown command shows none: every
/// argument is a value, and the entry has no target. That fails safe: it hides, never leaks.
fn key_positions(command: &str, args: &[Option<&[u8]>]) -> Vec<usize> {
    let count = args.len();
    let number = |index: usize| args.get(index).and_then(|arg| *arg).and_then(|arg| std::str::from_utf8(arg).ok()).and_then(|text| text.parse::<usize>().ok());
    match command {
        // Every argument is a key.
        "DEL" | "UNLINK" | "EXISTS" | "MGET" | "TOUCH" | "WATCH" | "SDIFF" | "SINTER" | "SUNION" | "SDIFFSTORE" | "SINTERSTORE" | "SUNIONSTORE"
        | "PFCOUNT" | "PFMERGE" => (0..count).collect(),
        // The last argument is a timeout.
        "BLPOP" | "BRPOP" => (0..count.saturating_sub(1)).collect(),
        "RENAME" | "RENAMENX" | "COPY" | "LMOVE" | "BLMOVE" | "RPOPLPUSH" | "BRPOPLPUSH" | "SMOVE" | "LCS" | "ZRANGESTORE" | "GEOSEARCHSTORE" => {
            (0..count.min(2)).collect()
        }
        "MSET" | "MSETNX" => (0..count).step_by(2).collect(),
        // `script numkeys key... arg...`
        "EVAL" | "EVALSHA" | "EVAL_RO" | "EVALSHA_RO" | "FCALL" | "FCALL_RO" => match number(1) {
            Some(keys) => (2..(2 + keys).min(count)).collect(),
            None => Vec::new(),
        },
        // `destination numkeys key... ...`
        "ZUNIONSTORE" | "ZINTERSTORE" | "ZDIFFSTORE" => {
            let mut positions = vec![0];
            if let Some(keys) = number(1) {
                positions.extend(2..(2 + keys).min(count));
            }
            positions
        }
        // Container commands: `OBJECT ENCODING key`.
        "OBJECT" | "MEMORY" | "XGROUP" | "XINFO" => if count > 1 { vec![1] } else { Vec::new() },
        _ if FIRST_KEY.binary_search(&command).is_ok() || command.starts_with("JSON.") || command.starts_with("TS.") => {
            if count > 0 { vec![0] } else { Vec::new() }
        }
        _ => Vec::new(),
    }
}

/// Commands whose first argument is a key, sorted for binary search.
const FIRST_KEY: &[&str] = &[
    "APPEND", "BITCOUNT", "BITFIELD", "BITFIELD_RO", "BITPOS", "DECR", "DECRBY", "DUMP", "EXPIRE", "EXPIREAT", "EXPIRETIME", "GEOADD", "GEODIST",
    "GEOHASH", "GEOPOS", "GEORADIUS", "GEORADIUSBYMEMBER", "GEORADIUSBYMEMBER_RO", "GEORADIUS_RO", "GEOSEARCH", "GET", "GETBIT", "GETDEL", "GETEX",
    "GETRANGE", "GETSET", "HDEL", "HEXISTS", "HEXPIRE", "HEXPIRETIME", "HGET", "HGETALL", "HGETDEL", "HGETEX", "HINCRBY", "HINCRBYFLOAT", "HKEYS",
    "HLEN", "HMGET", "HMSET", "HPERSIST", "HPEXPIRE", "HPEXPIRETIME", "HPTTL", "HRANDFIELD", "HSCAN", "HSET", "HSETEX", "HSETNX", "HSTRLEN", "HTTL",
    "HVALS", "INCR", "INCRBY", "INCRBYFLOAT", "LINDEX", "LINSERT", "LLEN", "LPOP", "LPOS", "LPUSH", "LPUSHX", "LRANGE", "LREM", "LSET", "LTRIM",
    "PERSIST", "PEXPIRE", "PEXPIREAT", "PEXPIRETIME", "PFADD", "PSETEX", "PTTL", "RESTORE", "RPOP", "RPUSH", "RPUSHX", "SADD", "SCARD", "SET",
    "SETBIT", "SETEX", "SETNX", "SETRANGE", "SISMEMBER", "SMEMBERS", "SMISMEMBER", "SORT", "SORT_RO", "SPOP", "SRANDMEMBER", "SREM", "SSCAN",
    "STRLEN", "SUBSTR", "TTL", "TYPE", "XACK", "XADD", "XAUTOCLAIM", "XCLAIM", "XDEL", "XLEN", "XPENDING", "XRANGE", "XREVRANGE", "XTRIM", "ZADD",
    "ZCARD", "ZCOUNT", "ZINCRBY", "ZLEXCOUNT", "ZMSCORE", "ZPOPMAX", "ZPOPMIN", "ZRANGE", "ZRANGEBYLEX", "ZRANGEBYSCORE", "ZRANK", "ZREM",
    "ZREMRANGEBYLEX", "ZREMRANGEBYRANK", "ZREMRANGEBYSCORE", "ZREVRANGE", "ZREVRANGEBYLEX", "ZREVRANGEBYSCORE", "ZREVRANK", "ZSCAN", "ZSCORE",
];

/// The `Db` statement and target of a command. `args` excludes the command name, and a `None` is a
/// cursor placeholder. Key arguments are shown as written; every other argument is `?`.
pub fn describe(command: &str, args: &[Option<&[u8]>]) -> (String, Option<String>) {
    let keys = key_positions(command, args);
    let text = |arg: &[u8]| String::from_utf8_lossy(arg).into_owned();
    let mut statement = command.to_owned();
    for (index, arg) in args.iter().enumerate() {
        statement.push(' ');
        match arg {
            Some(arg) if keys.contains(&index) => statement.push_str(&text(arg)),
            _ => statement.push('?'),
        }
    }
    let target = keys.first().and_then(|&index| args.get(index).copied().flatten()).map(text);
    (statement, target)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args<'a>(items: &[&'a str]) -> Vec<Option<&'a [u8]>> {
        items.iter().map(|item| Some(item.as_bytes())).collect()
    }

    #[test]
    fn the_table_is_sorted_for_binary_search() {
        assert!(FIRST_KEY.windows(2).all(|pair| pair[0] < pair[1]), "FIRST_KEY must stay sorted and free of duplicates");
    }

    #[test]
    fn a_value_never_appears() {
        assert_eq!(describe("SET", &args(&["session:42", "secret-token", "EX", "60"])), ("SET session:42 ? ? ?".into(), Some("session:42".into())));
        assert_eq!(describe("INCR", &args(&["counter:a"])), ("INCR counter:a".into(), Some("counter:a".into())));
    }

    #[test]
    fn multi_key_and_script_commands_show_their_keys() {
        assert_eq!(describe("MGET", &args(&["a", "b"])).0, "MGET a b");
        assert_eq!(describe("MSET", &args(&["a", "1", "b", "2"])).0, "MSET a ? b ?");
        assert_eq!(describe("EVAL", &args(&["return 1", "1", "k", "argument"])), ("EVAL ? ? k ?".into(), Some("k".into())));
        assert_eq!(describe("OBJECT", &args(&["ENCODING", "k"])).0, "OBJECT ? k");
        assert_eq!(describe("BLPOP", &args(&["q1", "q2", "5"])).0, "BLPOP q1 q2 ?");
    }

    #[test]
    fn unknown_commands_show_no_keys() {
        assert_eq!(describe("MYMODULE.GET", &args(&["k", "v"])), ("MYMODULE.GET ? ?".into(), None));
        assert_eq!(describe("JSON.GET", &args(&["doc", "$.name"])).0, "JSON.GET doc ?");
        assert_eq!(describe("SCAN", &[None]).0, "SCAN ?");
    }
}
