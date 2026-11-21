using System.Text.RegularExpressions;

namespace Sendproof.EntityFrameworkCore;

/// <summary>
/// Lightweight SQL statement classification for the Preview transaction-control guard
/// (spec/data-stores.md "Transaction-control statements from the handler"). The checks are deliberately
/// conservative: a statement that might end or replace the Preview transaction is refused.
/// </summary>
internal static partial class SqlStatements
{
    // BEGIN, START TRANSACTION, COMMIT [WORK|TRAN], END, ABORT, ROLLBACK without TO, PREPARE TRANSACTION, XA, and the
    // session settings that end the transaction. SAVEPOINT, RELEASE SAVEPOINT and ROLLBACK TO stay allowed because
    // ORMs use them for nested transactions. EF Core's SQL Server savepoint rollback (ROLLBACK TRANSACTION __EFSavePoint)
    // is allowed for the same reason.
    [GeneratedRegex(@"^(?:BEGIN|START\s+TRANSACTION|COMMIT|END|ABORT|ROLLBACK(?!\s+(?:(?:WORK|TRANSACTION|TRAN)\s+)?TO\b)(?!\s+TRAN(?:SACTION)?\s+\[?__EFSavePoint)|PREPARE\s+TRANSACTION|XA\b|SET\s+(?:(?:SESSION|GLOBAL|LOCAL)\s+|@@(?:SESSION\.|GLOBAL\.)?)?AUTOCOMMIT\b|SET\s+IMPLICIT_TRANSACTIONS\b)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex TransactionControl();

    // MySQL commits the open transaction before (and after) these statements.
    // https://dev.mysql.com/doc/refman/8.4/en/implicit-commit.html
    [GeneratedRegex(@"^(?:ALTER|CREATE|DROP|RENAME|TRUNCATE|GRANT|REVOKE|LOCK\s+TABLES?|UNLOCK\s+TABLES?|ANALYZE|OPTIMIZE|REPAIR|FLUSH|INSTALL|UNINSTALL|LOAD\s+(?:INDEX|DATA|XML)|CACHE\s+INDEX|RESET|SET\s+PASSWORD|START\s+REPLICA|STOP\s+REPLICA|CHANGE\s+REPLICATION)\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex MySqlImplicitCommit();

    [GeneratedRegex(@"^(?:CREATE|DROP)\s+TEMPORARY\s+TABLE\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex MySqlTemporaryTable();

    // MySQL and MariaDB run the body of /*! ... */ and /*M! ... */ comments as SQL.
    [GeneratedRegex(@"^/\*M?!\d*")]
    private static partial Regex ExecutableComment();

    /// <summary>Whether a statement executed inside the Preview transaction can end or replace it.</summary>
    /// <param name="sql">The command text, possibly several statements.</param>
    /// <param name="mysql">Whether the database is MySQL or MariaDB, which also commit implicitly.</param>
    internal static bool EndsTransaction(string sql, bool mysql) => Split(sql).Any(statement =>
        TransactionControl().IsMatch(statement) ||
        mysql && MySqlImplicitCommit().IsMatch(statement) && !MySqlTemporaryTable().IsMatch(statement));

    /// <summary>
    /// Splits SQL text into statements, ignoring separators inside quotes and comments. The body of a MySQL executable
    /// comment is kept as statement text, because the server runs it: <c>/*!COMMIT*/</c> is a COMMIT, not a comment.
    /// </summary>
    internal static IReadOnlyList<string> Split(string sql)
    {
        var statements = new List<string>();
        var current = new System.Text.StringBuilder();
        var index = 0;
        var executable = false;
        while (index < sql.Length)
        {
            var character = sql[index];
            var next = index + 1 < sql.Length ? sql[index + 1] : '\0';
            if (executable && character == '*' && next == '/')
            {
                executable = false;
                index += 2;
                current.Append(' ');
                continue;
            }

            if (character == '-' && next == '-')
            {
                var end = sql.IndexOf('\n', index);
                index = end == -1 ? sql.Length : end + 1;
                current.Append(' ');
                continue;
            }

            if (character == '/' && next == '*' && !executable)
            {
                var opener = ExecutableComment().Match(sql[index..Math.Min(sql.Length, index + 16)]);
                if (opener.Success)
                {
                    executable = true;
                    index += opener.Length;
                    current.Append(' ');
                    continue;
                }
            }

            if (character == '/' && next == '*')
            {
                var end = sql.IndexOf("*/", index + 2, StringComparison.Ordinal);
                index = end == -1 ? sql.Length : end + 2;
                current.Append(' ');
                continue;
            }

            if (character is '\'' or '"' or '`')
            {
                var end = ClosingQuote(sql, index, character);
                current.Append(sql, index, end - index);
                index = end;
                continue;
            }

            if (character == ';')
            {
                Flush(statements, current);
                index++;
                continue;
            }

            current.Append(character);
            index++;
        }

        Flush(statements, current);
        return statements;
    }

    private static void Flush(List<string> statements, System.Text.StringBuilder current)
    {
        var text = current.ToString().Trim();
        if (text.Length > 0)
        {
            statements.Add(text);
        }

        current.Clear();
    }

    private static int ClosingQuote(string sql, int start, char quote)
    {
        var index = start + 1;
        while (index < sql.Length)
        {
            if (sql[index] == '\\' && quote != '"')
            {
                index += 2;
                continue;
            }

            if (sql[index] == quote)
            {
                if (index + 1 < sql.Length && sql[index + 1] == quote)
                {
                    index += 2;
                    continue;
                }

                return index + 1;
            }

            index++;
        }

        return sql.Length;
    }
}
