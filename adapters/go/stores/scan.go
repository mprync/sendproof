package stores

import (
	"regexp"
	"strings"
)

// textScan is what scanText found in a statement.
type textScan struct {
	// words are the first words of the statement in upper case (at most two).
	words []string
	// extra is true when something other than whitespace and comments follows a
	// semicolon: a second statement.
	extra bool
	// wellFormed is false for an unterminated quote or block comment.
	wellFormed bool
}

// scanSyntax says which quotes and comments a language has.
type scanSyntax struct {
	// slashComments: `//` starts a line comment (CQL; not SQL).
	slashComments bool
	// dollarStrings: `$$ ... $$` is a string (CQL).
	dollarStrings bool
	// backticks: a backtick quotes an identifier (OpenSearch SQL).
	backticks bool
}

var (
	cqlSyntax = scanSyntax{slashComments: true, dollarStrings: true}
	sqlSyntax = scanSyntax{backticks: true}
)

// isWordByte reports whether c can be part of a keyword or identifier.
func isWordByte(c byte) bool {
	return c == '_' || c >= '0' && c <= '9' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z'
}

// skipComment returns the index after a comment that starts at text[index], and
// whether one starts there. An unterminated block comment sets unterminated.
func skipComment(text string, index int, syntax scanSyntax) (next int, comment, unterminated bool) {
	switch {
	case strings.HasPrefix(text[index:], "--") || syntax.slashComments && strings.HasPrefix(text[index:], "//"):
		end := strings.IndexByte(text[index:], '\n')
		if end < 0 {
			return len(text), true, false
		}
		return index + end + 1, true, false
	case strings.HasPrefix(text[index:], "/*"):
		end := strings.Index(text[index+2:], "*/")
		if end < 0 {
			return len(text), true, true
		}
		return index + 2 + end + 2, true, false
	}
	return index, false, false
}

// skipQuoted returns the index after the quoted run that starts at text[index]
// (a ' or " string, a backtick identifier, a $$ string) and whether one starts
// there. A quote is closed by its own character, doubled to escape it. A
// backslash is not an escape: reading it as one would let `'a\'; DELETE ...`
// look like one string when the engine sees the string end early, so the
// conservative reading wins.
func skipQuoted(text string, index int, syntax scanSyntax) (next int, quoted, unterminated bool) {
	c := text[index]
	switch {
	case c == '\'' || c == '"' || c == '`' && syntax.backticks:
		for cursor := index + 1; cursor < len(text); cursor++ {
			if text[cursor] != c {
				continue
			}
			if cursor+1 < len(text) && text[cursor+1] == c {
				cursor++
				continue
			}
			return cursor + 1, true, false
		}
		return len(text), true, true
	case syntax.dollarStrings && strings.HasPrefix(text[index:], "$$"):
		end := strings.Index(text[index+2:], "$$")
		if end < 0 {
			return len(text), true, true
		}
		return index + 2 + end + 2, true, false
	}
	return index, false, false
}

// scanText walks one statement text: it collects the first two words, notices a
// second statement after a semicolon and reports unterminated quotes or comments.
func scanText(text string, syntax scanSyntax) textScan {
	result := textScan{wellFormed: true}
	semicolon := false
	for index := 0; index < len(text); {
		c := text[index]
		if next, comment, unterminated := skipComment(text, index, syntax); comment {
			if unterminated {
				result.wellFormed = false
			}
			index = next
			continue
		}
		if c == ' ' || c == '\t' || c == '\r' || c == '\n' || c == '\v' || c == '\f' {
			index++
			continue
		}
		if c == ';' {
			semicolon = true
			index++
			continue
		}
		if semicolon {
			// Anything but whitespace, comments and more semicolons after a semicolon
			// is another statement.
			result.extra = true
		}
		if next, quoted, unterminated := skipQuoted(text, index, syntax); quoted {
			if unterminated {
				result.wellFormed = false
			}
			if len(result.words) < 2 && !semicolon {
				result.words = append(result.words, "")
			}
			index = next
			continue
		}
		if isWordByte(c) {
			end := index
			for end < len(text) && isWordByte(text[end]) {
				end++
			}
			if len(result.words) < 2 && !semicolon {
				result.words = append(result.words, strings.ToUpper(text[index:end]))
			}
			index = end
			continue
		}
		if len(result.words) < 2 && !semicolon {
			result.words = append(result.words, "")
		}
		index++
	}
	return result
}

var uuidLiteral = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}`)

// SanitizeLiterals returns query text with every literal replaced by ?: quoted
// strings, $$ strings (CQL), numbers, hex and UUID literals. Comments are dropped,
// because they can hold values. Double-quoted names are kept when
// doubleQuotedIsLiteral is false (CQL, PartiQL) and replaced when it is true
// (Cosmos DB SQL, where "open" is a string). A statement may inline values
// instead of using ? parameters, and a value never appears in a Db entry.
func SanitizeLiterals(text string, doubleQuotedIsLiteral bool) string {
	syntax := scanSyntax{slashComments: !doubleQuotedIsLiteral, dollarStrings: !doubleQuotedIsLiteral}
	var out strings.Builder
	for index := 0; index < len(text); {
		c := text[index]
		if next, comment, _ := skipComment(text, index, syntax); comment {
			out.WriteByte(' ')
			index = next
			continue
		}
		if c == '"' && !doubleQuotedIsLiteral {
			end := index + 1
			for end < len(text) {
				if text[end] == '"' {
					if end+1 < len(text) && text[end+1] == '"' {
						end += 2
						continue
					}
					break
				}
				end++
			}
			if end < len(text) {
				end++
			}
			out.WriteString(text[index:end])
			index = end
			continue
		}
		if next, quoted, _ := skipQuoted(text, index, syntax); quoted {
			out.WriteByte('?')
			index = next
			continue
		}
		previousIsWord := index > 0 && (isWordByte(text[index-1]) || text[index-1] == '.')
		if !previousIsWord && uuidLiteral.MatchString(text[index:]) {
			out.WriteByte('?')
			index += 36
			continue
		}
		if !previousIsWord && c >= '0' && c <= '9' {
			end := index
			for end < len(text) && (isWordByte(text[end]) || text[end] == '.' && end+1 < len(text) && text[end+1] >= '0' && text[end+1] <= '9' ||
				(text[end] == '+' || text[end] == '-') && (text[end-1] == 'e' || text[end-1] == 'E') && end+1 < len(text) && text[end+1] >= '0' && text[end+1] <= '9') {
				end++
			}
			out.WriteByte('?')
			index = end
			continue
		}
		out.WriteByte(c)
		index++
	}
	return strings.TrimSpace(out.String())
}
