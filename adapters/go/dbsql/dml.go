package dbsql

import (
	"database/sql"
	"strconv"
	"strings"
)

// dml is a single-table INSERT, REPLACE, UPDATE or DELETE that keyed capture
// understands well enough to read the affected rows by primary key. Statements
// outside these shapes are run unchanged and reported as not captured.
type dml struct {
	operation string // "insert", "replace", "update" or "delete"
	table     tableName
	// tableText and aliasText are the table reference and alias as written.
	tableText, aliasText string

	// UPDATE and DELETE: the WHERE condition and a trailing ORDER BY / LIMIT
	// (MySQL), as token ranges of the statement. An empty where matches all rows.
	where, tail []token
	hasLimit    bool
	// setColumns are the columns an UPDATE assigns.
	setColumns []string

	// INSERT and REPLACE.
	columns       []string      // nil when the statement omits the column list
	rows          [][]valueExpr // one entry per VALUES row
	defaultValues bool
	upsert        bool     // ON DUPLICATE KEY UPDATE or ON CONFLICT ... DO UPDATE
	ignore        bool     // INSERT IGNORE or ON CONFLICT DO NOTHING
	conflict      []string // PostgreSQL ON CONFLICT (columns)
	// valuesAt is the byte offset of VALUES or DEFAULT VALUES, where SQL Server's
	// OUTPUT clause goes.
	valuesAt int

	// returning reports a RETURNING or OUTPUT clause already in the statement.
	returning bool
}

// valueExpr is one element of a VALUES row: a placeholder or a literal can be
// used as a key; any other expression cannot.
type valueExpr struct {
	tok    token
	usable bool
}

// parseDML recognizes one statement. It returns false for anything else.
func parseDML(text string, statement []token, dialect Dialect) (*dml, bool) {
	words := leadingWords(statement, 1)
	if len(words) == 0 || statement[0].kind != tokWord {
		return nil, false
	}
	p := &parser{text: text, tokens: statement, dialect: dialect, at: 1}
	switch words[0] {
	case "UPDATE":
		return p.update()
	case "DELETE":
		return p.delete()
	case "INSERT":
		return p.insert("insert")
	case "REPLACE":
		if dialect == DialectMySQL {
			return p.insert("replace")
		}
	}
	return nil, false
}

type parser struct {
	text    string
	tokens  []token
	dialect Dialect
	at      int
}

func (p *parser) peek() token {
	if p.at < len(p.tokens) {
		return p.tokens[p.at]
	}
	return token{kind: tokPunct, start: len(p.text), end: len(p.text)}
}

func (p *parser) done() bool { return p.at >= len(p.tokens) }

// skipWords consumes any of the given keywords.
func (p *parser) skipWords(words ...string) []string {
	var skipped []string
	for !p.done() && p.peek().kind == tokWord {
		matched := false
		for _, word := range words {
			if p.peek().value == word {
				matched = true
			}
		}
		if !matched {
			break
		}
		skipped = append(skipped, p.peek().value)
		p.at++
	}
	return skipped
}

// tableRef reads [database.][schema.]table.
func (p *parser) tableRef() (tableName, string, bool) {
	start := p.at
	var parts []string
	for {
		name, ok := identifierText(p.text, p.peek())
		if !ok || p.peek().kind == tokWord && reservedAfterTable(p.peek().value) {
			return tableName{}, "", false
		}
		parts = append(parts, name)
		p.at++
		if !p.peek().is(tokPunct, ".") {
			break
		}
		p.at++
	}
	reference := p.text[p.tokens[start].start:p.tokens[p.at-1].end]
	table := tableName{name: parts[len(parts)-1]}
	if len(parts) > 1 {
		table.schema = parts[len(parts)-2]
	}
	return table, reference, true
}

func reservedAfterTable(word string) bool {
	switch word {
	case "SET", "WHERE", "VALUES", "VALUE", "DEFAULT", "SELECT", "OUTPUT", "RETURNING", "USING", "FROM",
		"ORDER", "LIMIT", "ON", "JOIN", "INNER", "LEFT", "RIGHT", "FULL", "CROSS", "STRAIGHT_JOIN", "PARTITION", "WITH", "OPTION":
		return true
	}
	return false
}

// alias reads an optional [AS] alias.
func (p *parser) alias() string {
	if p.peek().word("AS") {
		p.at++
		name, ok := identifierText(p.text, p.peek())
		if !ok {
			return ""
		}
		p.at++
		return name
	}
	if tok := p.peek(); tok.kind == tokIdent || tok.kind == tokWord && !reservedAfterTable(tok.value) {
		p.at++
		name, _ := identifierText(p.text, tok)
		return name
	}
	return ""
}

// until returns the index of the first depth-0 keyword in words, or the end.
func (p *parser) until(words ...string) int {
	depth := 0
	for index := p.at; index < len(p.tokens); index++ {
		tok := p.tokens[index]
		switch {
		case tok.is(tokPunct, "("):
			depth++
		case tok.is(tokPunct, ")"):
			depth--
		case depth == 0 && tok.kind == tokWord:
			for _, word := range words {
				if tok.value == word {
					return index
				}
			}
		}
	}
	return len(p.tokens)
}

// filter reads [WHERE condition] [ORDER BY ...] [LIMIT ...] up to RETURNING or OPTION.
func (p *parser) filter(plan *dml) bool {
	end := p.until("RETURNING", "OPTION")
	plan.returning = plan.returning || end < len(p.tokens) && p.tokens[end].word("RETURNING")
	if end < len(p.tokens) && p.tokens[end].word("OPTION") && p.dialect != DialectSQLServer {
		return false
	}
	if p.peek().word("WHERE") {
		p.at++
		if p.peek().word("CURRENT") {
			return false // WHERE CURRENT OF cursor
		}
		tailAt := p.until("ORDER", "LIMIT", "RETURNING", "OPTION")
		if tailAt > end {
			tailAt = end
		}
		plan.where = p.tokens[p.at:tailAt]
		p.at = tailAt
	}
	if p.at < end {
		if p.dialect != DialectMySQL || !(p.peek().word("ORDER") || p.peek().word("LIMIT")) {
			return false
		}
		plan.tail = p.tokens[p.at:end]
		plan.hasLimit = containsWord(plan.tail, "LIMIT")
	}
	return true
}

func (p *parser) update() (*dml, bool) {
	plan := &dml{operation: "update"}
	p.skipWords("LOW_PRIORITY", "IGNORE", "ONLY")
	if p.peek().word("TOP") {
		return nil, false
	}
	var ok bool
	if plan.table, plan.tableText, ok = p.tableRef(); !ok {
		return nil, false
	}
	if p.peek().is(tokPunct, "*") { // PostgreSQL inheritance marker
		p.at++
	}
	plan.aliasText = p.alias()
	if !p.peek().word("SET") {
		return nil, false // joins and multi-table updates
	}
	p.at++
	setEnd := p.until("WHERE", "FROM", "OUTPUT", "RETURNING", "ORDER", "LIMIT", "OPTION")
	plan.setColumns = assignedColumns(p.text, p.tokens[p.at:setEnd])
	p.at = setEnd
	if p.peek().word("OUTPUT") {
		plan.returning = true
		p.at = p.until("WHERE", "FROM", "OPTION")
	}
	if p.peek().word("FROM") {
		return nil, false
	}
	if !p.filter(plan) {
		return nil, false
	}
	return plan, true
}

func (p *parser) delete() (*dml, bool) {
	plan := &dml{operation: "delete"}
	p.skipWords("LOW_PRIORITY", "QUICK", "IGNORE")
	if p.peek().word("TOP") {
		return nil, false
	}
	if p.peek().word("FROM") {
		p.at++
	} else if p.dialect != DialectSQLServer {
		return nil, false // MySQL multi-table DELETE t1, t2 FROM ...
	}
	p.skipWords("ONLY")
	var ok bool
	if plan.table, plan.tableText, ok = p.tableRef(); !ok {
		return nil, false
	}
	if p.peek().is(tokPunct, "*") {
		p.at++
	}
	plan.aliasText = p.alias()
	if p.peek().word("OUTPUT") {
		plan.returning = true
		p.at = p.until("WHERE", "FROM", "OPTION")
	}
	if tok := p.peek(); tok.word("USING") || tok.word("FROM") || tok.is(tokPunct, ",") || tok.word("JOIN") {
		return nil, false
	}
	if !p.filter(plan) {
		return nil, false
	}
	return plan, true
}

func (p *parser) insert(operation string) (*dml, bool) {
	plan := &dml{operation: operation}
	modifiers := p.skipWords("LOW_PRIORITY", "DELAYED", "HIGH_PRIORITY", "IGNORE")
	for _, word := range modifiers {
		plan.ignore = plan.ignore || word == "IGNORE"
	}
	if p.peek().word("TOP") {
		return nil, false
	}
	p.skipWords("INTO")
	var ok bool
	if plan.table, plan.tableText, ok = p.tableRef(); !ok {
		return nil, false
	}
	if p.dialect == DialectPostgres && p.peek().word("AS") {
		p.at += 2
	}
	if p.peek().is(tokPunct, "(") {
		p.at++
		for !p.done() && !p.peek().is(tokPunct, ")") {
			name, ok := identifierText(p.text, p.peek())
			if !ok {
				return nil, false
			}
			plan.columns = append(plan.columns, name)
			p.at++
			if p.peek().is(tokPunct, ",") {
				p.at++
			}
		}
		if p.done() {
			return nil, false
		}
		p.at++
	}
	if p.peek().word("OUTPUT") {
		plan.returning = true
		p.at = p.until("VALUES", "VALUE", "DEFAULT", "SELECT")
	}
	if p.dialect == DialectPostgres && p.peek().word("OVERRIDING") {
		p.at += 3
	}
	plan.valuesAt = p.peek().start
	switch {
	case p.peek().word("DEFAULT"):
		p.at++
		if !p.peek().word("VALUES") {
			return nil, false
		}
		p.at++
		plan.defaultValues, plan.rows = true, [][]valueExpr{{}}
	case p.peek().word("VALUES") || p.peek().word("VALUE"):
		p.at++
		for {
			if p.peek().word("ROW") { // MySQL VALUES ROW(...)
				p.at++
			}
			row, ok := p.valuesRow()
			if !ok {
				return nil, false
			}
			plan.rows = append(plan.rows, row)
			if !p.peek().is(tokPunct, ",") {
				break
			}
			p.at++
		}
	default:
		return nil, false // INSERT ... SELECT and other sources
	}
	if p.dialect == DialectMySQL && p.peek().word("AS") { // row alias for ON DUPLICATE KEY UPDATE
		p.at += 2
		if p.peek().is(tokPunct, "(") {
			p.at = p.closing(p.at) + 1
		}
	}
	switch {
	case p.peek().word("ON") && p.at+1 < len(p.tokens) && p.tokens[p.at+1].word("DUPLICATE"):
		plan.upsert = true
		p.at = p.until("RETURNING")
	case p.peek().word("ON") && p.at+1 < len(p.tokens) && p.tokens[p.at+1].word("CONFLICT"):
		p.at += 2
		if p.peek().is(tokPunct, "(") {
			end := p.closing(p.at)
			for _, tok := range p.tokens[p.at+1 : end] {
				if name, ok := identifierText(p.text, tok); ok {
					plan.conflict = append(plan.conflict, name)
				}
			}
			p.at = end + 1
		} else if p.peek().word("ON") { // ON CONSTRAINT name
			plan.conflict = []string{"?constraint"}
		}
		doAt := p.until("DO")
		if doAt+1 >= len(p.tokens) {
			return nil, false
		}
		if p.tokens[doAt+1].word("NOTHING") {
			plan.ignore = true
		} else {
			plan.upsert = true
		}
		p.at = p.until("RETURNING")
	}
	if p.peek().word("RETURNING") {
		plan.returning = true
		p.at = len(p.tokens)
	}
	return plan, p.done()
}

// closing returns the index of the parenthesis that closes the one at open.
func (p *parser) closing(open int) int {
	depth := 0
	for index := open; index < len(p.tokens); index++ {
		switch {
		case p.tokens[index].is(tokPunct, "("):
			depth++
		case p.tokens[index].is(tokPunct, ")"):
			depth--
			if depth == 0 {
				return index
			}
		}
	}
	return len(p.tokens) - 1
}

// valuesRow reads one parenthesized row of VALUES.
func (p *parser) valuesRow() ([]valueExpr, bool) {
	if !p.peek().is(tokPunct, "(") {
		return nil, false
	}
	end := p.closing(p.at)
	if end >= len(p.tokens) || !p.tokens[end].is(tokPunct, ")") {
		return nil, false
	}
	var row []valueExpr
	start, depth := p.at+1, 0
	for index := p.at + 1; index <= end; index++ {
		tok := p.tokens[index]
		switch {
		case tok.is(tokPunct, "("):
			depth++
		case tok.is(tokPunct, ")") && index < end:
			depth--
		case depth == 0 && (tok.is(tokPunct, ",") || index == end):
			row = append(row, valueOf(p.tokens[start:index], p.dialect))
			start = index + 1
		}
	}
	p.at = end + 1
	return row, true
}

// valueOf accepts a placeholder or literal, optionally with a PostgreSQL cast.
func valueOf(tokens []token, dialect Dialect) valueExpr {
	if len(tokens) == 0 {
		return valueExpr{}
	}
	first := tokens[0]
	usable := first.kind == tokParam || first.kind == tokString || first.kind == tokNumber
	if len(tokens) > 1 {
		cast := dialect == DialectPostgres && len(tokens) >= 4 && tokens[1].is(tokPunct, ":") && tokens[2].is(tokPunct, ":")
		usable = usable && cast
	}
	return valueExpr{tok: first, usable: usable}
}

// assignedColumns returns the target columns of an UPDATE's SET list.
func assignedColumns(text string, tokens []token) []string {
	var columns []string
	depth := 0
	for index, tok := range tokens {
		switch {
		case tok.is(tokPunct, "("):
			depth++
		case tok.is(tokPunct, ")"):
			depth--
		case depth == 0 && tok.is(tokPunct, "=") && index > 0:
			if name, ok := identifierText(text, tokens[index-1]); ok {
				columns = append(columns, name)
			}
		}
	}
	return columns
}

// binder maps the placeholders of a statement to the call's arguments.
type binder struct {
	dialect Dialect
	args    []any
	byStart map[int]int
}

// newBinder numbers the placeholders of the whole text the way the driver binds
// them: bare ? in order of appearance, $n, ?n and @pn by position, and named
// placeholders by the sql.NamedArg of the same name.
func newBinder(tokens []token, args []any, dialect Dialect) binder {
	b := binder{dialect: dialect, args: args, byStart: map[int]int{}}
	ordinal := 0
	for _, tok := range tokens {
		if tok.kind != tokParam {
			continue
		}
		switch {
		case tok.param.position > 0:
			b.byStart[tok.start] = tok.param.position - 1
		case tok.param.name != "":
			b.byStart[tok.start] = namedIndex(args, tok.param.name, dialect)
		default:
			b.byStart[tok.start] = ordinal
			ordinal++
		}
	}
	return b
}

func namedIndex(args []any, name string, dialect Dialect) int {
	for index, arg := range args {
		if named, ok := arg.(sql.NamedArg); ok && strings.EqualFold(named.Name, name) {
			return index
		}
	}
	if dialect == DialectSQLServer && len(name) > 1 && (name[0] == 'p' || name[0] == 'P') {
		if position, err := strconv.Atoi(name[1:]); err == nil && position > 0 {
			return position - 1
		}
	}
	return -1
}

// value returns the argument a placeholder binds.
func (b binder) value(tok token) (any, bool) {
	index, ok := b.byStart[tok.start]
	if !ok || index < 0 || index >= len(b.args) {
		return nil, false
	}
	arg := b.args[index]
	if named, ok := arg.(sql.NamedArg); ok {
		arg = named.Value
	}
	return arg, true
}

// query builds SQL text with renumbered placeholders and the matching arguments.
type query struct {
	dialect Dialect
	text    strings.Builder
	args    []any
}

func (q *query) write(parts ...string) *query {
	for _, part := range parts {
		q.text.WriteString(part)
	}
	return q
}

// bind appends a placeholder for value.
func (q *query) bind(value any) *query {
	q.args = append(q.args, value)
	q.text.WriteString(q.dialect.placeholder(len(q.args)))
	return q
}

// copyTokens appends the source text of tokens, rebinding their placeholders.
func (q *query) copyTokens(source string, tokens []token, b binder) bool {
	if len(tokens) == 0 {
		return true
	}
	cursor := tokens[0].start
	for _, tok := range tokens {
		if tok.kind != tokParam {
			continue
		}
		value, ok := b.value(tok)
		if !ok {
			return false
		}
		q.text.WriteString(source[cursor:tok.start])
		q.bind(value)
		cursor = tok.end
	}
	q.text.WriteString(source[cursor:tokens[len(tokens)-1].end])
	return true
}
