package dbsql

import (
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

// The lexer splits SQL text into tokens so the provider can classify statements,
// refuse transaction control during a preview, track savepoints and plan the
// primary-key reads of the keyed capture. It understands each dialect's quoting,
// comments and bind placeholders, and never needs to understand expressions.

type tokenKind int

const (
	tokWord   tokenKind = iota // unquoted identifier or keyword
	tokIdent                   // quoted identifier
	tokString                  // string literal, including dollar-quoted bodies
	tokNumber                  // numeric literal
	tokParam                   // bind placeholder
	tokPunct                   // punctuation or operator character
)

// token is one lexical element with its byte range in the source text.
type token struct {
	kind       tokenKind
	start, end int
	// value is the upper-cased word, the unquoted identifier, the decoded string,
	// or the punctuation text.
	value string
	// param describes a placeholder.
	param paramRef
}

// paramRef identifies the argument a placeholder binds: by name, by explicit
// position (1-based) or, when both are empty, by order of appearance.
type paramRef struct {
	name     string
	position int
}

func (t token) is(kind tokenKind, value string) bool { return t.kind == kind && t.value == value }

func (t token) word(value string) bool { return t.kind == tokWord && t.value == value }

// lex tokenizes text for the dialect. Unterminated literals run to the end of the
// text; the database reports the syntax error itself.
func lex(text string, dialect Dialect) []token { return lexWith(text, dialect, false) }

// lexWith tokenizes text. With altStrings set it reads string literals under the
// dialect's other session setting: MySQL without backslash escapes
// (NO_BACKSLASH_ESCAPES, or ANSI_QUOTES identifiers) and PostgreSQL with
// backslash escapes (standard_conforming_strings off). The preview guard checks
// both readings, so a statement cannot hide transaction control inside what only
// one of them considers a string.
func lexWith(text string, dialect Dialect, altStrings bool) []token {
	var tokens []token
	// quoteBackslash reports whether a backslash escapes the next byte in '...'
	// and, for MySQL, "..." literals.
	quoteBackslash := dialect == DialectMySQL && !altStrings || dialect == DialectPostgres && altStrings
	// executable is set inside a MySQL /*! ... */ or MariaDB /*M! ... */ comment,
	// whose content the server runs as SQL.
	executable := false
	for i := 0; i < len(text); {
		c := text[i]
		switch {
		case c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f':
			i++
		case executable && c == '*' && strings.HasPrefix(text[i:], "*/"):
			executable = false
			i += 2
		case c == '-' && strings.HasPrefix(text[i:], "--") && (dialect != DialectMySQL || mysqlDashComment(text, i)),
			c == '#' && dialect == DialectMySQL:
			for i < len(text) && text[i] != '\n' {
				i++
			}
		case c == '/' && dialect == DialectMySQL && !executable && (strings.HasPrefix(text[i:], "/*!") || strings.HasPrefix(text[i:], "/*M!")):
			// The server executes the body of an executable comment (an optional
			// version number follows the marker), so it is lexed as SQL.
			i += strings.IndexByte(text[i:], '!') + 1
			i, _ = scanDigits(text, i)
			executable = true
		case c == '/' && strings.HasPrefix(text[i:], "/*"):
			i = skipBlockComment(text, i, dialect == DialectPostgres)
		case c == '\'':
			end, value := scanQuoted(text, i, '\'', quoteBackslash)
			tokens = append(tokens, token{kind: tokString, start: i, end: end, value: value})
			i = end
		case c == '"':
			end, value := scanQuoted(text, i, '"', dialect == DialectMySQL && quoteBackslash)
			kind := tokIdent
			if dialect == DialectMySQL { // without ANSI_QUOTES MySQL reads "..." as a string
				kind = tokString
			}
			tokens = append(tokens, token{kind: kind, start: i, end: end, value: value})
			i = end
		case c == '`':
			end, value := scanQuoted(text, i, '`', false)
			tokens = append(tokens, token{kind: tokIdent, start: i, end: end, value: value})
			i = end
		case c == '[' && (dialect == DialectSQLServer || dialect == DialectSQLite):
			end := i + 1
			var value strings.Builder
			for end < len(text) {
				if text[end] == ']' {
					if end+1 < len(text) && text[end+1] == ']' {
						value.WriteByte(']')
						end += 2
						continue
					}
					end++
					break
				}
				value.WriteByte(text[end])
				end++
			}
			tokens = append(tokens, token{kind: tokIdent, start: i, end: end, value: value.String()})
			i = end
		case c == '$' && dialect == DialectPostgres:
			if end, ok := scanDigits(text, i+1); ok {
				position, _ := strconv.Atoi(text[i+1 : end])
				tokens = append(tokens, token{kind: tokParam, start: i, end: end, param: paramRef{position: position}})
				i = end
				continue
			}
			if end, body, ok := scanDollarQuote(text, i); ok {
				tokens = append(tokens, token{kind: tokString, start: i, end: end, value: body})
				i = end
				continue
			}
			tokens = append(tokens, token{kind: tokPunct, start: i, end: i + 1, value: "$"})
			i++
		case c == '?' && dialect != DialectPostgres:
			if end, ok := scanDigits(text, i+1); ok && dialect == DialectSQLite {
				position, _ := strconv.Atoi(text[i+1 : end])
				tokens = append(tokens, token{kind: tokParam, start: i, end: end, param: paramRef{position: position}})
				i = end
				continue
			}
			tokens = append(tokens, token{kind: tokParam, start: i, end: i + 1})
			i++
		case c == '@' && dialect == DialectSQLServer && strings.HasPrefix(text[i:], "@@"):
			// @@TRANCOUNT and the other system functions are values, not placeholders.
			end := scanWord(text, i+2)
			tokens = append(tokens, token{kind: tokWord, start: i, end: end, value: strings.ToUpper(text[i:end])})
			i = end
		case (c == '@' || c == ':' || c == '$') && namedParamDialect(c, dialect) && i+1 < len(text) && isWordStart(text, i+1):
			end := scanWord(text, i+1)
			tokens = append(tokens, token{kind: tokParam, start: i, end: end, param: paramRef{name: text[i+1 : end]}})
			i = end
		case c == '@' && dialect == DialectMySQL:
			// MySQL @user and @@system variables are values, not placeholders.
			end := i + 1
			for end < len(text) && text[end] == '@' {
				end++
			}
			end = scanWord(text, end)
			tokens = append(tokens, token{kind: tokWord, start: i, end: end, value: strings.ToUpper(text[i:end])})
			i = end
		case c >= '0' && c <= '9' || c == '.' && i+1 < len(text) && text[i+1] >= '0' && text[i+1] <= '9':
			end := scanNumber(text, i)
			tokens = append(tokens, token{kind: tokNumber, start: i, end: end, value: text[i:end]})
			i = end
		case isWordStart(text, i):
			end := scanWord(text, i)
			// N'...', E'...', X'...' and B'...' are prefixed string literals.
			if end == i+1 && end < len(text) && text[end] == '\'' && strings.ContainsRune("NnEeXxBb", rune(c)) {
				backslash := quoteBackslash || dialect == DialectPostgres && (c == 'E' || c == 'e')
				stop, value := scanQuoted(text, end, '\'', backslash)
				tokens = append(tokens, token{kind: tokString, start: i, end: stop, value: value})
				i = stop
				continue
			}
			tokens = append(tokens, token{kind: tokWord, start: i, end: end, value: strings.ToUpper(text[i:end])})
			i = end
		default:
			size := 1
			if c >= utf8.RuneSelf {
				_, size = utf8.DecodeRuneInString(text[i:])
			}
			tokens = append(tokens, token{kind: tokPunct, start: i, end: i + size, value: text[i : i+size]})
			i += size
		}
	}
	return tokens
}

// mysqlDashComment reports whether the "--" at i starts a MySQL comment, which
// needs a following space or control character: MySQL reads 1--1 as 1 - -1.
func mysqlDashComment(text string, i int) bool {
	return i+2 >= len(text) || text[i+2] <= ' '
}

func namedParamDialect(prefix byte, dialect Dialect) bool {
	switch dialect {
	case DialectSQLite:
		return true // SQLite accepts @name, :name and $name
	case DialectSQLServer:
		return prefix == '@'
	}
	return false
}

func isWordStart(text string, i int) bool {
	r, _ := utf8.DecodeRuneInString(text[i:])
	return r == '_' || unicode.IsLetter(r)
}

func scanWord(text string, i int) int {
	for i < len(text) {
		r, size := utf8.DecodeRuneInString(text[i:])
		if r != '_' && r != '$' && !unicode.IsLetter(r) && !unicode.IsDigit(r) {
			break
		}
		i += size
	}
	return i
}

func scanDigits(text string, i int) (int, bool) {
	start := i
	for i < len(text) && text[i] >= '0' && text[i] <= '9' {
		i++
	}
	return i, i > start
}

func scanNumber(text string, i int) int {
	if strings.HasPrefix(text[i:], "0x") || strings.HasPrefix(text[i:], "0X") {
		i += 2
		for i < len(text) && strings.IndexByte("0123456789abcdefABCDEF", text[i]) >= 0 {
			i++
		}
		return i
	}
	for i < len(text) && (text[i] >= '0' && text[i] <= '9' || text[i] == '.') {
		i++
	}
	if i < len(text) && (text[i] == 'e' || text[i] == 'E') {
		next := i + 1
		if next < len(text) && (text[next] == '+' || text[next] == '-') {
			next++
		}
		if end, ok := scanDigits(text, next); ok {
			i = end
		}
	}
	return i
}

// scanQuoted reads a literal opened by quote at text[start], where a doubled quote
// stands for itself and, when backslash is set, a backslash escapes the next byte.
func scanQuoted(text string, start int, quote byte, backslash bool) (int, string) {
	var value strings.Builder
	i := start + 1
	for i < len(text) {
		c := text[i]
		switch {
		case backslash && c == '\\' && i+1 < len(text):
			value.WriteByte(unescape(text[i+1]))
			i += 2
		case c == quote && i+1 < len(text) && text[i+1] == quote:
			value.WriteByte(quote)
			i += 2
		case c == quote:
			return i + 1, value.String()
		default:
			value.WriteByte(c)
			i++
		}
	}
	return i, value.String()
}

func unescape(c byte) byte {
	switch c {
	case 'n':
		return '\n'
	case 't':
		return '\t'
	case 'r':
		return '\r'
	case '0':
		return 0
	}
	return c
}

func skipBlockComment(text string, i int, nested bool) int {
	depth := 0
	for i < len(text) {
		switch {
		case strings.HasPrefix(text[i:], "/*"):
			depth++
			i += 2
		case strings.HasPrefix(text[i:], "*/"):
			depth--
			i += 2
			if depth == 0 || !nested {
				return i
			}
		default:
			i++
		}
	}
	return i
}

// scanDollarQuote reads a PostgreSQL $tag$...$tag$ string.
func scanDollarQuote(text string, start int) (int, string, bool) {
	end := start + 1
	for end < len(text) && text[end] != '$' {
		r, size := utf8.DecodeRuneInString(text[end:])
		if r != '_' && !unicode.IsLetter(r) && !unicode.IsDigit(r) {
			return 0, "", false
		}
		end += size
	}
	if end >= len(text) {
		return 0, "", false
	}
	tag := text[start : end+1]
	closing := strings.Index(text[end+1:], tag)
	if closing < 0 {
		return len(text), text[end+1:], true
	}
	return end + 1 + closing + len(tag), text[end+1 : end+1+closing], true
}

// splitStatements groups tokens into statements separated by top-level semicolons.
// Empty statements are dropped.
func splitStatements(tokens []token) [][]token {
	var statements [][]token
	start := 0
	for index, tok := range tokens {
		if tok.is(tokPunct, ";") {
			if index > start {
				statements = append(statements, tokens[start:index])
			}
			start = index + 1
		}
	}
	if start < len(tokens) {
		statements = append(statements, tokens[start:])
	}
	return statements
}

// leadingWords returns the upper-cased keywords a statement starts with, skipping
// opening parentheses, up to count words.
func leadingWords(statement []token, count int) []string {
	words := make([]string, 0, count)
	for _, tok := range statement {
		if tok.is(tokPunct, "(") && len(words) == 0 {
			continue
		}
		if tok.kind != tokWord {
			break
		}
		words = append(words, tok.value)
		if len(words) == count {
			break
		}
	}
	return words
}

// identifierText returns the name of an identifier token: quoted identifiers keep
// their case, unquoted ones keep the spelling of the source.
func identifierText(text string, tok token) (string, bool) {
	switch tok.kind {
	case tokIdent:
		return tok.value, true
	case tokWord:
		return text[tok.start:tok.end], true
	}
	return "", false
}

// sameName compares identifiers the way the databases fold unquoted names.
func sameName(a, b string) bool { return strings.EqualFold(a, b) }
