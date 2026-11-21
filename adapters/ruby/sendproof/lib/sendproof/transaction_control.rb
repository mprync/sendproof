# frozen_string_literal: true

module Sendproof
  # Recognizes SQL that would end or escape the transaction a rollback preview runs in (the shared
  # +raw-commit+ and +mysql-escape+ rules, spec/data-stores.md "Transaction-control statements from
  # the handler").
  #
  # The checks are deliberately conservative: a statement that might end the transaction is
  # refused, which can only fail a preview, never confirm one. Savepoint statements stay allowed
  # because ORMs use them for nested transactions, except on the savepoint the provider reserves.
  #
  # On MySQL and MariaDB +CALL+ is refused too, because a stored procedure can commit, unless the
  # host declared that procedure safe by exact name; so are SQL-level +PREPARE+ and +EXECUTE+, which
  # run statement text the guard never saw.
  #
  # Quotes and comments are read the way each server reads them by default: on MySQL backslashes
  # escape inside every string, +#+ starts a comment and +--+ does only when a space follows; elsewhere
  # a standard string has no backslash escapes (PostgreSQL's +E'...'+ strings do) and +$tag$+ quotes a
  # body. A literal that ended later than the server's would hide a statement the server runs.
  module TransactionControl
    # MySQL and MariaDB run the body of +/*! ... */+ and +/*M! ... */+ comments as SQL.
    EXECUTABLE_COMMENT = %r{\A/\*M?!\d*}

    CONTROL = /\A(?:BEGIN|START\s+TRANSACTION|COMMIT|END|ABORT|ROLLBACK(?!\s+(?:WORK\s+|TRANSACTION\s+)?TO\b)|PREPARE\s+TRANSACTION|XA\b|SET\s+(?:(?:SESSION|GLOBAL|LOCAL)\s+|@@(?:SESSION\.|GLOBAL\.)?)?AUTOCOMMIT\b|SET\s+IMPLICIT_TRANSACTIONS\b)/i

    # A +SET+ that changes autocommit anywhere in its list (+SET sql_mode = '', autocommit = 1+).
    SET_AUTOCOMMIT = /\ASET\b.*(?<![\w$])AUTOCOMMIT\b/im

    # MySQL commits the open transaction before (and after) these statements.
    # https://dev.mysql.com/doc/refman/8.4/en/implicit-commit.html
    MYSQL_IMPLICIT_COMMIT = /\A(?:ALTER|CREATE|DROP|RENAME|TRUNCATE|GRANT|REVOKE|LOCK\s+TABLES?|UNLOCK\s+TABLES?|ANALYZE|OPTIMIZE|REPAIR|CHECK\s+TABLES?|FLUSH|INSTALL|UNINSTALL|LOAD\s+(?:INDEX|DATA|XML)|CACHE\s+INDEX|RESET|SET\s+PASSWORD|SET\s+DEFAULT\s+ROLE|START\s+(?:REPLICA|SLAVE|GROUP_REPLICATION)|STOP\s+(?:REPLICA|SLAVE|GROUP_REPLICATION)|CHANGE\s+(?:REPLICATION|MASTER)|IMPORT\s+TABLE|CLONE)\b/i
    MYSQL_TEMPORARY_TABLE = /\A(?:CREATE|DROP)\s+TEMPORARY\s+TABLE\b/i

    # SQL-level +PREPARE ... FROM+ and +EXECUTE+ (also MariaDB's +EXECUTE IMMEDIATE+): they run statement
    # text the guard never sees.
    MYSQL_EXECUTE = /\A(?:PREPARE|EXECUTE)\b/i

    # +CALL name+, +CALL schema.name+, with or without backticks; the name is captured.
    MYSQL_CALL = /\ACALL\s+((?:`(?:[^`]|``)+`|[\w$]+)(?:\s*\.\s*(?:`(?:[^`]|``)+`|[\w$]+))?)/i
    MYSQL_CALL_KEYWORD = /\ACALL\b/i

    # A declared safe procedure: a plain name, optionally qualified with its schema.
    PROCEDURE_NAME = /\A[A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)?\z/

    module_function

    # Checks and lower-cases the host's declared safe procedures. MySQL and MariaDB procedure names are
    # case-insensitive, so +Refresh_Totals+ and +refresh_totals+ are one procedure. Exact names only:
    # wildcards and quoting are rejected rather than guessed at.
    #
    # @param names [Array<String>]
    # @return [Array<String>] frozen
    # @raise [ArgumentError] for anything but an exact name
    def normalize_procedures(names)
      Array(names).map do |name|
        raise ArgumentError, "A safe procedure must be an exact name such as \"refresh_totals\", not #{name.inspect}." unless name.is_a?(String) && name.match?(PROCEDURE_NAME)

        name.downcase.freeze
      end.uniq.freeze
    end

    # Splits SQL text into statements, ignoring separators inside quotes and comments. The body of a
    # MySQL executable comment is kept as statement text, because the server runs it: +/*!COMMIT*/+
    # is a COMMIT, not a comment.
    #
    # @param mysql [Boolean] read quotes and comments the way MySQL and MariaDB do
    # @return [Array<String>]
    def split(sql, mysql: false)
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
        elsif char == "-" && following == "-" && (!mysql || sql[index + 2].nil? || sql[index + 2].match?(/[[:space:]]|[[:cntrl:]]/))
          index = line_end(sql, index)
          current << " "
        elsif char == "#" && mysql
          index = line_end(sql, index)
          current << " "
        elsif char == "/" && following == "*" && !executable && (opener = EXECUTABLE_COMMENT.match(sql[index, 16]))
          # Read as SQL on every database: a stricter check elsewhere, where only MySQL runs it.
          executable = true
          index += opener[0].length
          current << " "
        elsif char == "/" && following == "*"
          close = sql.index("*/", index + 2)
          index = close ? close + 2 : sql.length
          current << " "
        elsif ["'", '"', "`"].include?(char)
          stop = closing_quote(sql, index, char, backslash: backslash_escapes?(sql, index, char, mysql))
          current << sql[index...stop]
          index = stop
        elsif char == "$" && (mysql || (index.positive? && sql[index - 1].match?(/[\w$]/)))
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
    # @param safe_procedures [Array<String>] lower-cased names from {normalize_procedures}; any other
    #   +CALL+ is refused on MySQL and MariaDB
    # @param reserved [String, nil] a savepoint the provider owns: the handler may not release or roll
    #   back to it
    # @return [Boolean] whether it can end or replace the preview transaction
    def ends_transaction?(sql, mysql: false, safe_procedures: [], reserved: nil)
      !reason(sql, mysql: mysql, safe_procedures: safe_procedures, reserved: reserved).nil?
    end

    # Why +sql+ would end or escape the preview transaction, or nil when it is safe.
    # @return [String, nil]
    def reason(sql, mysql: false, safe_procedures: [], reserved: nil)
      split(sql.to_s, mysql: mysql).each do |statement|
        verb = statement.split.first.to_s.upcase
        return "the handler's #{verb} would end the Preview transaction" if statement.match?(CONTROL) || statement.match?(SET_AUTOCOMMIT)
        if reserved && statement.match?(/\A(?:RELEASE|ROLLBACK|SAVEPOINT)\b/i) && statement.match?(/(?<![\w$])`?#{Regexp.escape(reserved)}`?(?![\w$])/i)
          return "the Preview's own savepoint is reserved for Sendproof"
        end
        next unless mysql

        if statement.match?(MYSQL_CALL_KEYWORD)
          name = MYSQL_CALL.match(statement)&.[](1)
          next if name && safe_procedures.include?(procedure_key(name))

          return "a CALL can commit the Preview transaction inside the procedure; declare the procedure safe by exact name if it never commits"
        end
        return "the handler's #{verb} runs a statement the Preview can't check" if statement.match?(MYSQL_EXECUTE)
        return "the handler's #{verb} commits implicitly on MySQL" if statement.match?(MYSQL_IMPLICIT_COMMIT) && !statement.match?(MYSQL_TEMPORARY_TABLE)
      end
      nil
    end

    # +`Shop` . `Rebuild`+ -> +"shop.rebuild"+; a quoted name that isn't a plain name never matches.
    def procedure_key(name)
      name.split(/\s*\.\s*/).map { |part| part.delete_prefix("`").delete_suffix("`") }.join(".").downcase
    end

    def line_end(sql, index)
      newline = sql.index("\n", index)
      newline ? newline + 1 : sql.length
    end

    # Whether a backslash escapes the next character inside the quote that opens at +index+.
    def backslash_escapes?(sql, index, quote, mysql)
      return quote != "`" if mysql

      quote == "'" && index.positive? && sql[index - 1].match?(/[Ee]/) && (index == 1 || !sql[index - 2].match?(/[\w$]/))
    end

    def closing_quote(sql, start, quote, backslash:)
      index = start + 1
      while index < sql.length
        if backslash && sql[index] == "\\"
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
