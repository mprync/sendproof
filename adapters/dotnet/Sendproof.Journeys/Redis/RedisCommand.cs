namespace Sendproof.Journeys;

/// <summary>The Redis write commands a step can expect. The expectations document writes them upper-case, as Redis names them.</summary>
public enum RedisCommand
{
    /// <summary><c>SET</c></summary>
    Set,

    /// <summary><c>INCR</c></summary>
    Incr,

    /// <summary><c>INCRBY</c></summary>
    IncrBy,

    /// <summary><c>DECR</c></summary>
    Decr,

    /// <summary><c>DECRBY</c></summary>
    DecrBy,

    /// <summary><c>DEL</c></summary>
    Del,

    /// <summary><c>EXPIRE</c></summary>
    Expire,

    /// <summary><c>HSET</c></summary>
    HSet,

    /// <summary><c>HDEL</c></summary>
    HDel,

    /// <summary><c>LPUSH</c></summary>
    LPush,

    /// <summary><c>RPUSH</c></summary>
    RPush,

    /// <summary><c>SADD</c></summary>
    SAdd,

    /// <summary><c>SREM</c></summary>
    SRem,

    /// <summary><c>ZADD</c></summary>
    ZAdd,

    /// <summary><c>ZREM</c></summary>
    ZRem
}
