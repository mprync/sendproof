# frozen_string_literal: true

module Sendproof
  # Recognizes SQL that would end or escape the transaction a rollback preview runs in (the shared
  # +raw-commit+ rule, spec/data-stores.md "Transaction-control statements from the handler").
  #
  # The checks are deliberately conservative: a statement that might end the transaction is
  # refused, which can only fail a preview, never confirm one. Savepoint statements stay allowed
  # because ORMs use them for nested transactions.
  module TransactionControl
    # MySQL and MariaDB run the body of +/*! ... */+ and +/*M! ... */+ comments as SQL.
    EXECUTABLE_COMMENT = %r{\A/\*M?!\d*}

    CONTROL = /\A(?:BEGIN|START\s+TRANSACTION|COMMIT|END|ABORT|ROLLBACK(?!\s+(?:WORK\s+|TRANSACTION\s+)?TO\b)|PREPARE\s+TRANSACTION|XA\b|SET\s+(?:(?:SESSION|GLOBAL|LOCAL)\s+|@@(?:SESSION\.|GLOBAL\.)?)?AUTOCOMMIT\b|SET\s+IMPLICIT_TRANSACTIONS\b)/i

    # MySQL commits the open transaction before (and after) these statements.
    # https://dev.mysql.com/doc/refman/8.4/en/implicit-commit.html
    MYSQL_IMPLICIT_COMMIT = /\A(?:ALTER|CREATE|DROP|RENAME|TRUNCATE|GRANT|REVOKE|LOCK\s+TABLES?|UNLOCK\s+TABLES?|ANALYZE|OPTIMIZE|REPAIR|FLUSH|INSTALL|UNINSTALL|LOAD\s+(?:INDEX|DATA|XML)|CACHE\s+INDEX|RESET|SET\s+PASSWORD|START\s+REPLICA|STOP\s+REPLICA|CHANGE\s+REPLICATION)\b/i
    MYSQL_TEMPORARY_TABLE = /\A(?:CREATE|DROP)\s+TEMPORARY\s+TABLE\b/i

    module_function

    # Splits SQL text into statements, ignoring separators inside quotes and comments. The body of a
    # MySQL executable comment is kept as statement text, because the server runs it: +/*!COMMIT*/+
    # is a COMMIT, not a comment.
    #
    # @return [Array<String>]
    def split(sql)
      statements = []
      current = +""
      index = 0
      executable = false
      while index < sql.length
        char = sql[index]
        following = sql[index + 1]
        if executable && char == "*" && following == "/"
          executable = false
          index += 2
          current << " "
        elsif char == "-" && following == "-"
          newline = sql.index("\n", index)
          index = newline ? newline + 1 : sql.length
          current << " "
        elsif char == "/" && following == "*" && !executable && (opener = EXECUTABLE_COMMENT.match(sql[index, 16]))
          executable = true
          index += opener[0].length
          current << " "
        elsif char == "/" && following == "*"
          close = sql.index("*/", index + 2)
          index = close ? close + 2 : sql.length
          current << " "
        elsif ["'", '"', "`"].include?(char)
          stop = closing_quote(sql, index, char)
          current << sql[index...stop]
          index = stop
        elsif char == "$" && index.positive? && sql[index - 1].match?(/[\w$]/)
          current << char
          index += 1
        elsif char == "$" && (tag = /\A\$[A-Za-z_]*\$/.match(sql[index..]))
          close = sql.index(tag[0], index + tag[0].length)
          stop = close ? close + tag[0].length : sql.length
          current << sql[index...stop]
          index = stop
        elsif char == ";"
          statements << current.strip unless current.strip.empty?
          current = +""
          index += 1
        else
          current << char
          index += 1
        end
      end
      statements << current.strip unless current.strip.empty?
      statements
    end

    # @param sql [String] the statement text the application is about to run
    # @param mysql [Boolean] whether the database is MySQL or MariaDB, which also commit implicitly
    # @return [Boolean] whether it can end or replace the preview transaction
    def ends_transaction?(sql, mysql: false)
      split(sql.to_s).any? do |statement|
        statement.match?(CONTROL) || (mysql && statement.match?(MYSQL_IMPLICIT_COMMIT) && !statement.match?(MYSQL_TEMPORARY_TABLE))
      end
    end

    def closing_quote(sql, start, quote)
      index = start + 1
      while index < sql.length
        if sql[index] == "\\" && quote != '"'
          index += 2
        elsif sql[index] == quote && sql[index + 1] == quote
          index += 2 # A doubled quote is an escaped quote.
        elsif sql[index] == quote
          return index + 1
        else
          index += 1
        end
      end
      sql.length
    end
  end
end
