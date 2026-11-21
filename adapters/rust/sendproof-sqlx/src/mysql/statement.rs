//! Recognizes the single-table writes whose rows MySQL can capture by primary key.
//!
//! This is not a SQL parser. It tokenizes the statement (quotes, comments and parentheses aware)
//! and accepts only these shapes; anything else returns `None` and runs uncaptured:
//!
//! * `INSERT|REPLACE [modifiers] [INTO] t [(columns)] VALUES|VALUE (row)[, (row)...] [AS alias]
//!   [ON DUPLICATE KEY UPDATE ...]`
//! * `UPDATE [modifiers] t [[AS] alias] SET ... [WHERE ...] [ORDER BY ...] [LIMIT ...]`
//! * `DELETE [modifiers] FROM t [[AS] alias] [WHERE ...] [ORDER BY ...] [LIMIT ...]`

use serde_json::Value;

/// A token, with its byte offset in the statement.
#[derive(Debug, Clone, PartialEq)]
enum Kind {
    /// An unquoted word: keyword, identifier or number.
    Word(String),
    /// A backquoted identifier, unquoted.
    Quoted(String),
    /// A string literal, unescaped.
    Text(String),
    /// A named parameter, without its prefix.
    Param(String),
    Open,
    Close,
    Comma,
    Dot,
    Other(char),
}

#[derive(Debug, Clone)]
struct Token {
    kind: Kind,
    at: usize,
}

fn tokenize(sql: &str) -> Vec<Token> {
    let bytes: Vec<(usize, char)> = sql.char_indices().collect();
    let mut tokens = Vec::new();
    let mut index = 0;
    let word_char = |c: char| c.is_alphanumeric() || c == '_' || c == '$';
    while index < bytes.len() {
        let (at, c) = bytes[index];
        let next = bytes.get(index + 1).map(|&(_, n)| n);
        if c.is_whitespace() {
            index += 1;
        } else if c == '#' || (c == '-' && next == Some('-')) {
            while index < bytes.len() && bytes[index].1 != '\n' {
                index += 1;
            }
        } else if c == '/' && next == Some('*') {
            index += 2;
            while index < bytes.len() && !(bytes[index].1 == '*' && bytes.get(index + 1).map(|&(_, n)| n) == Some('/')) {
                index += 1;
            }
            index += 2;
        } else if c == '\'' || c == '"' || c == '`' {
            let mut text = String::new();
            index += 1;
            while index < bytes.len() {
                let current = bytes[index].1;
                index += 1;
                if current == '\\' && c != '`' && index < bytes.len() {
                    text.push(bytes[index].1);
                    index += 1;
                } else if current == c {
                    if bytes.get(index).map(|&(_, n)| n) == Some(c) {
                        text.push(c);
                        index += 1;
                    } else {
                        break;
                    }
                } else {
                    text.push(current);
                }
            }
            tokens.push(Token { kind: if c == '`' { Kind::Quoted(text) } else { Kind::Text(text) }, at });
        } else if (c == ':' || c == '$') && next.is_some_and(|n| n.is_alphabetic() || n == '_') {
            let start = index + 1;
            index = start;
            while index < bytes.len() && (bytes[index].1.is_alphanumeric() || bytes[index].1 == '_') {
                index += 1;
            }
            tokens.push(Token { kind: Kind::Param(bytes[start..index].iter().map(|&(_, c)| c).collect()), at });
        } else if word_char(c) {
            let start = index;
            while index < bytes.len() && (word_char(bytes[index].1) || (bytes[index].1 == '.' && c.is_ascii_digit())) {
                index += 1;
            }
            tokens.push(Token { kind: Kind::Word(bytes[start..index].iter().map(|&(_, c)| c).collect()), at });
        } else {
            let kind = match c {
                '(' => Kind::Open,
                ')' => Kind::Close,
                ',' => Kind::Comma,
                '.' => Kind::Dot,
                other => Kind::Other(other),
            };
            tokens.push(Token { kind, at });
            index += 1;
        }
    }
    tokens
}

/// A value written into a primary key column.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Expr {
    Param(String),
    Literal(Value),
    /// `NULL` or `DEFAULT`: the column takes its default, such as the next auto-increment value.
    Default,
    /// Any other expression: the value is unknown before the statement runs.
    Other,
}

/// A recognized single-table write.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Write {
    Insert {
        table: TableName,
        /// The listed columns, or `None` for all columns in table order.
        columns: Option<Vec<String>>,
        rows: Vec<Vec<Expr>>,
        replace: bool,
        upsert: bool,
        ignore: bool,
    },
    Update {
        table: TableName,
        alias: Option<String>,
        /// Columns assigned by `SET`.
        assigned: Vec<String>,
        /// `WHERE`, `ORDER BY` and `LIMIT`, verbatim, or empty.
        tail: String,
    },
    Delete {
        table: TableName,
        alias: Option<String>,
        tail: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) struct TableName {
    pub(crate) schema: Option<String>,
    pub(crate) name: String,
}

struct Cursor<'a> {
    sql: &'a str,
    tokens: Vec<Token>,
    index: usize,
}

impl Cursor<'_> {
    fn peek(&self) -> Option<&Kind> {
        self.tokens.get(self.index).map(|t| &t.kind)
    }

    fn keyword(&self) -> Option<String> {
        match self.peek() {
            Some(Kind::Word(word)) => Some(word.to_ascii_uppercase()),
            _ => None,
        }
    }

    fn eat(&mut self, keyword: &str) -> bool {
        if self.keyword().as_deref() == Some(keyword) {
            self.index += 1;
            true
        } else {
            false
        }
    }

    fn skip_all(&mut self, keywords: &[&str]) -> Vec<String> {
        let mut seen = Vec::new();
        while let Some(word) = self.keyword().filter(|w| keywords.contains(&w.as_str())) {
            seen.push(word);
            self.index += 1;
        }
        seen
    }

    fn identifier(&mut self) -> Option<String> {
        let name = match self.peek()? {
            Kind::Word(word) => word.clone(),
            Kind::Quoted(name) => name.clone(),
            _ => return None,
        };
        self.index += 1;
        Some(name)
    }

    fn table(&mut self) -> Option<TableName> {
        let first = self.identifier()?;
        if self.peek() == Some(&Kind::Dot) {
            self.index += 1;
            let name = self.identifier()?;
            return Some(TableName { schema: Some(first), name });
        }
        Some(TableName { schema: None, name: first })
    }

    /// An optional `[AS] alias` before one of `stop`.
    fn alias(&mut self, stop: &[&str]) -> Option<Option<String>> {
        if self.eat("AS") {
            return self.identifier().map(Some);
        }
        match self.keyword() {
            Some(word) if stop.contains(&word.as_str()) => Some(None),
            Some(_) => self.identifier().map(Some),
            None if self.peek().is_none() => Some(None),
            None => match self.peek() {
                Some(Kind::Quoted(_)) => self.identifier().map(Some),
                _ => None,
            },
        }
    }

    /// The tokens of a parenthesized group, split at top-level commas. The cursor must be on `(`.
    fn group(&mut self) -> Option<Vec<Vec<Kind>>> {
        if self.peek() != Some(&Kind::Open) {
            return None;
        }
        self.index += 1;
        let mut items = vec![Vec::new()];
        let mut depth = 0;
        loop {
            let kind = self.peek()?.clone();
            self.index += 1;
            match kind {
                Kind::Close if depth == 0 => return Some(items),
                Kind::Comma if depth == 0 => items.push(Vec::new()),
                other => {
                    match other {
                        Kind::Open => depth += 1,
                        Kind::Close => depth -= 1,
                        _ => {}
                    }
                    items.last_mut().expect("at least one item").push(other);
                }
            }
        }
    }

    /// The byte offset of the first top-level token among `keywords`, from the cursor on.
    fn find_top_level(&self, keywords: &[&str]) -> Option<usize> {
        let mut depth = 0i32;
        for token in &self.tokens[self.index..] {
            match &token.kind {
                Kind::Open => depth += 1,
                Kind::Close => depth -= 1,
                Kind::Word(word) if depth == 0 && keywords.contains(&word.to_ascii_uppercase().as_str()) => return Some(token.at),
                _ => {}
            }
        }
        None
    }

    fn tail_from(&self, at: Option<usize>) -> String {
        at.map_or(String::new(), |at| self.sql[at..].trim().trim_end_matches(';').trim().to_owned())
    }
}

fn expr(tokens: &[Kind]) -> Expr {
    match tokens {
        [Kind::Param(name)] => Expr::Param(name.clone()),
        [Kind::Text(text)] => Expr::Literal(Value::String(text.clone())),
        [Kind::Word(word)] if word.eq_ignore_ascii_case("NULL") || word.eq_ignore_ascii_case("DEFAULT") => Expr::Default,
        [Kind::Word(word)] => number(word, false).unwrap_or(Expr::Other),
        [Kind::Other('-'), Kind::Word(word)] => number(word, true).unwrap_or(Expr::Other),
        _ => Expr::Other,
    }
}

fn number(word: &str, negative: bool) -> Option<Expr> {
    let text = if negative { format!("-{word}") } else { word.to_owned() };
    if let Ok(value) = text.parse::<i64>() {
        return Some(Expr::Literal(value.into()));
    }
    text.parse::<f64>().ok().filter(|v| v.is_finite()).map(|value| Expr::Literal(value.into()))
}

/// Recognizes `sql`, or returns `None` when its rows cannot be captured by primary key.
pub(crate) fn analyze(sql: &str) -> Option<Write> {
    let mut cursor = Cursor { sql, tokens: tokenize(sql), index: 0 };
    match cursor.keyword()?.as_str() {
        verb @ ("INSERT" | "REPLACE") => {
            let replace = verb == "REPLACE";
            cursor.index += 1;
            let modifiers = cursor.skip_all(&["LOW_PRIORITY", "DELAYED", "HIGH_PRIORITY", "IGNORE"]);
            cursor.eat("INTO");
            let table = cursor.table()?;
            let columns = match cursor.peek() {
                Some(Kind::Open) => Some(
                    cursor
                        .group()?
                        .into_iter()
                        .map(|item| match item.as_slice() {
                            [Kind::Word(name)] | [Kind::Quoted(name)] => Some(name.clone()),
                            _ => None,
                        })
                        .collect::<Option<Vec<_>>>()?,
                ),
                _ => None,
            };
            if !(cursor.eat("VALUES") || cursor.eat("VALUE")) {
                return None;
            }
            let mut rows = Vec::new();
            loop {
                rows.push(cursor.group()?.iter().map(|item| expr(item)).collect::<Vec<_>>());
                if cursor.peek() == Some(&Kind::Comma) {
                    cursor.index += 1;
                } else {
                    break;
                }
            }
            if columns.as_ref().is_some_and(|columns| rows.iter().any(|row| row.len() != columns.len())) {
                return None;
            }
            if cursor.eat("AS") {
                cursor.identifier()?;
                if cursor.peek() == Some(&Kind::Open) {
                    cursor.group()?;
                }
            }
            let upsert = cursor.eat("ON");
            if upsert && !(cursor.eat("DUPLICATE") && cursor.eat("KEY") && cursor.eat("UPDATE")) {
                return None;
            }
            if !upsert && cursor.peek().is_some_and(|kind| *kind != Kind::Other(';')) {
                return None;
            }
            Some(Write::Insert { table, columns, rows, replace, upsert, ignore: modifiers.iter().any(|m| m == "IGNORE") })
        }
        "UPDATE" => {
            cursor.index += 1;
            cursor.skip_all(&["LOW_PRIORITY", "IGNORE"]);
            let table = cursor.table()?;
            let alias = cursor.alias(&["SET"])?;
            if !cursor.eat("SET") {
                return None;
            }
            let tail_at = cursor.find_top_level(&["WHERE", "ORDER", "LIMIT"]);
            // Columns assigned at the top level of SET: `[alias.]column = ...` after SET or a comma.
            let mut assigned = Vec::new();
            let end = tail_at.unwrap_or(usize::MAX);
            let mut depth = 0i32;
            let mut expect_target = true;
            let mut position = cursor.index;
            while let Some(token) = cursor.tokens.get(position).filter(|t| t.at < end) {
                match &token.kind {
                    Kind::Open => depth += 1,
                    Kind::Close => depth -= 1,
                    Kind::Comma if depth == 0 => expect_target = true,
                    Kind::Word(name) | Kind::Quoted(name) if depth == 0 && expect_target => {
                        let qualified = cursor.tokens.get(position + 1).is_some_and(|t| t.kind == Kind::Dot);
                        if !qualified {
                            assigned.push(name.clone());
                            expect_target = false;
                        }
                    }
                    Kind::Word(word) if depth == 0 && word.eq_ignore_ascii_case("JOIN") => return None,
                    _ => {}
                }
                position += 1;
            }
            Some(Write::Update { table, alias, assigned, tail: cursor.tail_from(tail_at) })
        }
        "DELETE" => {
            cursor.index += 1;
            cursor.skip_all(&["LOW_PRIORITY", "QUICK", "IGNORE"]);
            if !cursor.eat("FROM") {
                return None;
            }
            let table = cursor.table()?;
            let alias = cursor.alias(&["WHERE", "ORDER", "LIMIT"])?;
            match cursor.keyword().as_deref() {
                Some("WHERE" | "ORDER" | "LIMIT") => {}
                None if cursor.peek().is_none() || cursor.peek() == Some(&Kind::Other(';')) => {}
                _ => return None,
            }
            let tail_at = cursor.find_top_level(&["WHERE", "ORDER", "LIMIT"]);
            Some(Write::Delete { table, alias, tail: cursor.tail_from(tail_at) })
        }
        _ => None,
    }
}

/// Whether a statement that was not recognized may still have written rows.
pub(crate) fn may_write(sql: &str) -> bool {
    !matches!(
        tokenize(sql).first().map(|t| &t.kind),
        Some(Kind::Word(word)) if ["SELECT", "SHOW", "DESCRIBE", "DESC", "EXPLAIN", "SET", "DO"]
            .contains(&word.to_ascii_uppercase().as_str())
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table(name: &str) -> TableName {
        TableName { schema: None, name: name.into() }
    }

    #[test]
    fn recognizes_inserts_with_parameters_literals_and_defaults() {
        let write = analyze("INSERT INTO items (id, name, n) VALUES (:id, 'it''s', -2), (DEFAULT, :name, 1.5)").unwrap();
        assert_eq!(
            write,
            Write::Insert {
                table: table("items"),
                columns: Some(vec!["id".into(), "name".into(), "n".into()]),
                rows: vec![
                    vec![Expr::Param("id".into()), Expr::Literal("it's".into()), Expr::Literal((-2).into())],
                    vec![Expr::Default, Expr::Param("name".into()), Expr::Literal(1.5.into())],
                ],
                replace: false,
                upsert: false,
                ignore: false,
            }
        );
    }

    #[test]
    fn recognizes_replace_ignore_and_upserts() {
        let Some(Write::Insert { replace: true, .. }) = analyze("REPLACE `shop`.`items` VALUES (:id, :name)") else { panic!() };
        let Some(Write::Insert { ignore: true, upsert: false, .. }) = analyze("INSERT IGNORE items (id) VALUE (1)") else { panic!() };
        let upsert = analyze("INSERT INTO items (id, name) VALUES (:id, :name) AS new ON DUPLICATE KEY UPDATE name = new.name");
        let Some(Write::Insert { upsert: true, table, .. }) = upsert else { panic!() };
        assert_eq!(table, table_name_of("items"));
    }

    fn table_name_of(name: &str) -> TableName {
        table(name)
    }

    #[test]
    fn keeps_schema_qualified_tables() {
        let Some(Write::Delete { table, .. }) = analyze("DELETE FROM `shop`.items WHERE id = :id") else { panic!() };
        assert_eq!(table, TableName { schema: Some("shop".into()), name: "items".into() });
    }

    #[test]
    fn recognizes_updates_with_their_tail_and_assigned_columns() {
        let write =
            analyze("UPDATE items i SET i.name = :name, total = (SELECT 1 WHERE x = 2) WHERE id = :id ORDER BY id LIMIT 1;").unwrap();
        assert_eq!(
            write,
            Write::Update {
                table: table("items"),
                alias: Some("i".into()),
                assigned: vec!["name".into(), "total".into()],
                tail: "WHERE id = :id ORDER BY id LIMIT 1".into(),
            }
        );
        let Some(Write::Update { tail, alias: None, .. }) = analyze("UPDATE items SET name = 'x'") else { panic!() };
        assert!(tail.is_empty());
    }

    #[test]
    fn recognizes_deletes() {
        let Some(Write::Delete { tail, alias: None, .. }) = analyze("DELETE FROM items WHERE id = :id") else { panic!() };
        assert_eq!(tail, "WHERE id = :id");
        let Some(Write::Delete { tail, .. }) = analyze("delete from items") else { panic!() };
        assert!(tail.is_empty());
    }

    #[test]
    fn rejects_shapes_it_cannot_capture() {
        for sql in [
            "INSERT INTO items SELECT * FROM other",
            "INSERT INTO items SET id = 1",
            "UPDATE items JOIN other ON other.id = items.id SET items.name = other.name",
            "UPDATE items, other SET items.name = other.name",
            "DELETE items FROM items JOIN other ON other.id = items.id",
            "DELETE FROM items USING items JOIN other",
            "INSERT INTO items (id) VALUES (1, 2)",
            "SELECT 1",
            "CALL refresh()",
        ] {
            assert_eq!(analyze(sql), None, "{sql}");
        }
    }

    #[test]
    fn ignores_comments_and_quoted_keywords() {
        let Some(Write::Delete { tail, .. }) = analyze("/* note */ DELETE -- x\n FROM items WHERE name = 'WHERE'") else { panic!() };
        assert_eq!(tail, "WHERE name = 'WHERE'");
    }

    #[test]
    fn tells_reads_from_possible_writes() {
        assert!(!may_write("SELECT :x"));
        assert!(!may_write("  show tables"));
        assert!(may_write("CALL refresh()"));
        assert!(may_write("INSERT INTO t SELECT 1"));
    }
}
