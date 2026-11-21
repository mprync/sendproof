package stores

import "strings"

// SanitizeDocument renders a command document as JSON text with every literal value
// replaced by "?", keeping field names and operators: the `statement` of a MongoDB
// Db entry (OpenTelemetry db.query.text). Values never appear in a capture.
func SanitizeDocument(value any) string {
	var out strings.Builder
	writeSanitized(&out, value)
	return out.String()
}

func writeSanitized(out *strings.Builder, value any) {
	switch typed := value.(type) {
	case Doc:
		out.WriteByte('{')
		for index, field := range typed {
			if index > 0 {
				out.WriteByte(',')
			}
			out.WriteString(quote(field.Key))
			out.WriteByte(':')
			writeSanitized(out, field.Value)
		}
		out.WriteByte('}')
	case []any:
		out.WriteByte('[')
		for index, item := range typed {
			if index > 0 {
				out.WriteByte(',')
			}
			writeSanitized(out, item)
		}
		out.WriteByte(']')
	default:
		out.WriteString(`"?"`)
	}
}

// quote renders s as a JSON string.
func quote(s string) string {
	var out strings.Builder
	out.WriteByte('"')
	for _, r := range s {
		switch {
		case r == '"' || r == '\\':
			out.WriteByte('\\')
			out.WriteRune(r)
		case r < 0x20:
			out.WriteString(`\u00`)
			out.WriteByte("0123456789abcdef"[r>>4])
			out.WriteByte("0123456789abcdef"[r&15])
		default:
			out.WriteRune(r)
		}
	}
	out.WriteByte('"')
	return out.String()
}

// SanitizePartiQL replaces every literal in PartiQL text with ?: single-quoted
// strings (with ” escapes) and numbers. Double-quoted identifiers (table and
// attribute names) are kept as written. A statement may inline values instead of
// using ? parameters, and a value never appears in a Db entry.
func SanitizePartiQL(text string) string {
	var out strings.Builder
	for index := 0; index < len(text); {
		char := text[index]
		switch {
		case char == '"':
			end := strings.IndexByte(text[index+1:], '"')
			stop := len(text)
			if end >= 0 {
				stop = index + 1 + end + 1
			}
			out.WriteString(text[index:stop])
			index = stop
		case char == '\'':
			end := index + 1
			for end < len(text) && !(text[end] == '\'' && (end+1 >= len(text) || text[end+1] != '\'')) {
				if text[end] == '\'' {
					end += 2
				} else {
					end++
				}
			}
			out.WriteByte('?')
			index = end + 1
		case char >= '0' && char <= '9' && (index == 0 || !isWordOrDot(text[index-1])):
			end := index
			for end < len(text) && text[end] >= '0' && text[end] <= '9' {
				end++
			}
			if end+1 < len(text) && text[end] == '.' && text[end+1] >= '0' && text[end+1] <= '9' {
				end++
				for end < len(text) && text[end] >= '0' && text[end] <= '9' {
					end++
				}
			}
			if end < len(text) && (text[end] == 'e' || text[end] == 'E') {
				exponent := end + 1
				if exponent < len(text) && (text[exponent] == '+' || text[exponent] == '-') {
					exponent++
				}
				if exponent < len(text) && text[exponent] >= '0' && text[exponent] <= '9' {
					for exponent < len(text) && text[exponent] >= '0' && text[exponent] <= '9' {
						exponent++
					}
					end = exponent
				}
			}
			out.WriteByte('?')
			index = end
		default:
			out.WriteByte(char)
			index++
		}
	}
	return out.String()
}

func isWordOrDot(c byte) bool {
	return c == '.' || c == '_' || c >= '0' && c <= '9' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z'
}

// singleKey lists the Redis commands whose first argument is the only key, and
// allKeys those whose every argument is a key. A command in neither shows no
// keys: an unknown argument could be a value, and values never appear in a capture.
var singleKey = set(strings.Fields(`
GET SET GETDEL GETEX GETSET GETRANGE SETRANGE GETBIT SETBIT SETEX PSETEX SETNX APPEND STRLEN
INCR DECR INCRBY DECRBY INCRBYFLOAT BITCOUNT BITPOS BITFIELD BITFIELD_RO LCS
EXPIRE PEXPIRE EXPIREAT PEXPIREAT PERSIST TTL PTTL EXPIRETIME PEXPIRETIME TYPE DUMP RESTORE
HGET HSET HMSET HSETNX HGETALL HDEL HEXISTS HINCRBY HINCRBYFLOAT HKEYS HVALS HLEN HMGET HSCAN HSTRLEN HRANDFIELD
HEXPIRE HPEXPIRE HTTL HPTTL HPERSIST HEXPIRETIME HPEXPIRETIME
LPUSH RPUSH LPUSHX RPUSHX LPOP RPOP LLEN LRANGE LINDEX LSET LREM LTRIM LINSERT LPOS
SADD SREM SMEMBERS SISMEMBER SMISMEMBER SCARD SPOP SRANDMEMBER SSCAN
ZADD ZREM ZRANGE ZRANGEBYSCORE ZRANGEBYLEX ZREVRANGE ZREVRANGEBYSCORE ZSCORE ZMSCORE ZCARD ZRANK ZREVRANK ZINCRBY
ZCOUNT ZLEXCOUNT ZPOPMIN ZPOPMAX ZSCAN ZREMRANGEBYRANK ZREMRANGEBYSCORE ZREMRANGEBYLEX ZRANDMEMBER
XADD XLEN XRANGE XREVRANGE XDEL XTRIM XACK XCLAIM XAUTOCLAIM XPENDING
PFADD GEOADD GEODIST GEOHASH GEOPOS GEOSEARCH GEORADIUS GEORADIUS_RO GEORADIUSBYMEMBER GEORADIUSBYMEMBER_RO
SORT SORT_RO COPY RENAME RENAMENX MOVE
JSON.GET JSON.SET JSON.DEL JSON.TYPE JSON.NUMINCRBY JSON.STRAPPEND JSON.ARRAPPEND JSON.OBJKEYS JSON.OBJLEN JSON.ARRLEN
`), false)

var allKeys = set(strings.Fields(`
DEL UNLINK EXISTS TOUCH MGET WATCH PFCOUNT PFMERGE SDIFF SINTER SUNION SDIFFSTORE SINTERSTORE SUNIONSTORE SMOVE
BLPOP BRPOP LMOVE BLMOVE RPOPLPUSH
`), false)

// RedisStatement builds the `statement` and `target` of a Redis Db entry: the
// command name, then each key argument as written and every other argument as ?
// (SET session:42 ?). Values never appear. The target is the first key argument.
// An unknown command shows no keys.
func RedisStatement(name string, args []string) (statement, target string) {
	command := strings.ToUpper(name)
	parts := []string{command}
	switch {
	case allKeys[command]:
		for index, arg := range args {
			if command == "SMOVE" && index == 2 || command == "BLPOP" && index == len(args)-1 || command == "BRPOP" && index == len(args)-1 {
				parts = append(parts, "?")
				continue
			}
			parts = append(parts, arg)
		}
		if len(args) > 0 {
			target = args[0]
		}
	case singleKey[command] && len(args) > 0:
		parts = append(parts, args[0])
		target = args[0]
		for range args[1:] {
			parts = append(parts, "?")
		}
	case command == "MSET" || command == "MSETNX":
		for index, arg := range args {
			if index%2 == 0 {
				parts = append(parts, arg)
			} else {
				parts = append(parts, "?")
			}
		}
		if len(args) > 0 {
			target = args[0]
		}
	default:
		for range args {
			parts = append(parts, "?")
		}
	}
	return strings.Join(parts, " "), target
}
