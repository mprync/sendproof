using System.Data;
using System.Text;
using System.Text.RegularExpressions;

namespace Sendproof.EntityFrameworkCore;

/// <summary>
/// Lightweight SQL statement classification for the Preview transaction-control guard
/// (spec/data-stores.md "Transaction-control statements from the handler"). The checks are deliberately
/// conservative: a statement that might end or replace the Preview transaction is refused.
/// </summary>
/// <remarks>
/// SQL text is read the way the server reads it, so nothing can hide a statement from the check: string literals are
/// read both with and without backslash escapes (MySQL's default and <c>NO_BACKSLASH_ESCAPES</c>, PostgreSQL's
/// <c>E''</c> and standard strings), refusing if either reading finds a statement; the body of a <c>/*! ... */</c>
/// executable comment is SQL; on MySQL <c>#</c> starts a comment and <c>--</c> starts one only before whitespace; on
/// other databases a PostgreSQL <c>$tag$</c> string is one literal.
/// </remarks>
internal static partial class SqlStatements
{
    /// <summary>
    /// The MySQL backstop savepoint (see <see cref="PreviewSavepoint"/>). No ORM generates this name; EF Core's own
    /// savepoints are <c>__EFSavePoint</c>.
    /// </summary>
    internal const string PreviewSavepointName = "sendproof_preview";

    /// <summary>Stands for a doubled backtick inside a quoted identifier, which no declared procedure name contains.</summary>
    private const char EscapedBacktick = '\u0001';

    // BEGIN, START TRANSACTION, COMMIT [WORK|TRAN], END, ABORT, ROLLBACK without TO, PREPARE TRANSACTION, XA, and the
    // session settings that end the transaction, in any spelling and anywhere in a SET list (a user variable such as
    // @autocommit is not a setting). SQL Server's SET IMPLICIT_TRANSACTIONS OFF, which EF Core starts its batches with,
    // leaves an open transaction open, so it is allowed. SAVEPOINT, RELEASE SAVEPOINT and ROLLBACK TO stay allowed because ORMs use them for
    // nested transactions. EF Core's SQL Server savepoint rollback (ROLLBACK TRANSACTION __EFSavePoint) is allowed for
    // the same reason.
    [GeneratedRegex(@"^(?:BEGIN|START\s+TRANSACTION|COMMIT|END|ABORT|ROLLBACK(?!\s+(?:(?:WORK|TRANSACTION|TRAN)\s+)?TO\b)(?!\s+TRAN(?:SACTION)?\s+\[?__EFSavePoint)|PREPARE\s+TRANSACTION|XA\b|SET\b(?:.*[\s,])?(?:@@(?:(?:SESSION|GLOBAL|LOCAL)\.)?|(?:SESSION|GLOBAL|LOCAL)\s+)?(?:AUTOCOMMIT\b|IMPLICIT_TRANSACTIONS\b(?!\s*(?:=\s*)?OFF\b)))", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.Singleline)]
    private static partial Regex TransactionControl();

    // MySQL commits the open transaction before (and after) these statements.
    // https://dev.mysql.com/doc/refman/8.4/en/implicit-commit.html
    // PREPARE and EXECUTE are refused too: they can run any of these, or COMMIT, from a string.
    [GeneratedRegex(@"^(?:ALTER|CREATE|DROP|RENAME|TRUNCATE|GRANT|REVOKE|LOCK|UNLOCK\s+TABLES?|ANALYZE|OPTIMIZE|REPAIR|CHECK\s+TABLE|FLUSH|INSTALL|UNINSTALL|LOAD\s+(?:INDEX|DATA|XML)|CACHE\s+INDEX|RESET|SET\s+PASSWORD|(?:START|STOP)\s+(?:REPLICA|SLAVE|GROUP_REPLICATION)|CHANGE\s+(?:REPLICATION|MASTER)|IMPORT\s+TABLE|PREPARE|EXECUTE)\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex MySqlImplicitCommit();

    [GeneratedRegex(@"^(?:CREATE|DROP)\s+TEMPORARY\s+TABLE\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex MySqlTemporaryTable();

    // A stored procedure can run COMMIT or an implicitly committing statement inside the Preview transaction.
    [GeneratedRegex(@"^CALL\s+(?<name>[^\s(;]+(?:\s*\.\s*[^\s(;]+)?)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex MySqlCall();

    // On every database: releasing the backstop savepoint, rolling back to it or making it again would hide a commit from
    // the backstop. SQL Server spells these SAVE TRANSACTION and ROLLBACK TRANSACTION; names may be quoted.
    [GeneratedRegex(@"^(?:SAVEPOINT|RELEASE(?:\s+SAVEPOINT)?|ROLLBACK\s+(?:WORK\s+)?TO(?:\s+SAVEPOINT)?|SAVE\s+TRAN(?:SACTION)?|ROLLBACK\s+TRAN(?:SACTION)?)\s+[`""\[]?sendproof_preview[`""\]]?\s*$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex PreviewSavepointStatement();

    // MySQL and MariaDB run the body of /*! ... */ and /*M! ... */ comments as SQL.
    [GeneratedRegex(@"^/\*M?!\d*")]
    private static partial Regex ExecutableComment();

    [GeneratedRegex(@"^\$[A-Za-z_]*\$")]
    private static partial Regex DollarQuote();

    /// <summary>Whether a statement executed inside the Preview transaction can end or replace it.</summary>
    /// <param name="sql">The command text, possibly several statements.</param>
    /// <param name="mysql">Whether the database is MySQL or MariaDB, which also commit implicitly and run procedures.</param>
    /// <param name="safeProcedures">Procedures the host declared never commit, from <see cref="SafeProcedures"/>.</param>
    internal static bool EndsTransaction(string sql, bool mysql, IReadOnlySet<string>? safeProcedures = null)
    {
        foreach (var backslashEscapes in new[] { true, false })
        {
            if (Split(sql, mysql, backslashEscapes).Any(statement => EndsTransactionStatement(statement, mysql, safeProcedures)))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Whether a command can end or replace the Preview transaction. On MySQL a <see cref="CommandType.StoredProcedure"/>
    /// command is a <c>CALL</c> of the procedure its text names.
    /// </summary>
    internal static bool EndsTransaction(CommandType type, string text, bool mysql, IReadOnlySet<string>? safeProcedures) =>
        type == CommandType.StoredProcedure
            ? mysql && safeProcedures?.Contains(ProcedureName(text)) != true
            : EndsTransaction(text, mysql, safeProcedures);

    /// <summary>
    /// Normalises host-declared safe procedure names: exact names only, optionally schema-qualified
    /// (<c>reports.refresh_totals</c>), compared without backticks and case-insensitively as MySQL does.
    /// </summary>
    /// <exception cref="ArgumentException">A name is blank or has a wildcard (<c>*</c>, <c>%</c>, <c>?</c>) or whitespace.</exception>
    internal static IReadOnlySet<string> SafeProcedures(IEnumerable<string> names)
    {
        var normalised = new HashSet<string>(StringComparer.Ordinal);
        foreach (var name in names)
        {
            var bare = ProcedureName(name ?? "");
            if (bare.Length == 0 || bare.Any(character => character is '*' or '%' or '?' || char.IsWhiteSpace(character) || char.IsControl(character)) ||
                (name ?? "").Any(char.IsWhiteSpace))
            {
                throw new ArgumentException($"Safe procedures take exact names, without wildcards or spaces: '{name}'.", nameof(names));
            }

            normalised.Add(bare);
        }

        return normalised;
    }

    private static string ProcedureName(string name) =>
        new string(name.Where(character => character != '`' && !char.IsWhiteSpace(character)).ToArray()).ToLowerInvariant();

    private static bool EndsTransactionStatement(string statement, bool mysql, IReadOnlySet<string>? safeProcedures)
    {
        if (TransactionControl().IsMatch(statement) || PreviewSavepointStatement().IsMatch(statement))
        {
            return true;
        }

        if (!mysql)
        {
            return false;
        }

        var call = MySqlCall().Match(statement);
        if (call.Success)
        {
            return safeProcedures?.Contains(ProcedureName(call.Groups["name"].Value)) != true;
        }

        return MySqlImplicitCommit().IsMatch(statement) && !MySqlTemporaryTable().IsMatch(statement);
    }

    /// <summary>
    /// Splits SQL text into statements, ignoring separators inside quotes and comments, with every string literal
    /// replaced by <c>'s'</c> so a pattern can't match inside one. The body of a MySQL executable comment is kept as
    /// statement text, because the server runs it: <c>/*!COMMIT*/</c> is a COMMIT, not a comment.
    /// </summary>
    /// <param name="sql">The command text.</param>
    /// <param name="mysql">Whether to apply MySQL's comment and quoting rules.</param>
    /// <param name="backslashEscapes">Whether a backslash escapes the next character in a string literal.</param>
    internal static IReadOnlyList<string> Split(string sql, bool mysql = false, bool backslashEscapes = true)
    {
        var statements = new List<string>();
        var current = new StringBuilder();
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

            var lineComment = character == '-' && next == '-' &&
                (!mysql || index + 2 >= sql.Length || sql[index + 2] <= ' ') || mysql && character == '#';
            if (lineComment)
            {
                var end = sql.IndexOf('\n', index);
                end = end == -1 ? sql.Length : end;
                if (executable)
                {
                    // Assume the comment stops at the executable comment's end, so text after it is still checked.
                    var close = sql.IndexOf("*/", index, StringComparison.Ordinal);
                    end = close != -1 && close < end ? close : end;
                }

                index = end;
                current.Append(' ');
                continue;
            }

            if (character == '-' && mysql)
            {
                // Two minus signs not followed by whitespace are operators on MySQL; keep them from reading as a comment.
                current.Append("- ");
                index++;
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

            if (character == '\'' || character == '"' && mysql)
            {
                index = AfterString(sql, index, character, backslashEscapes);
                current.Append(" 's' ");
                continue;
            }

            if (character is '"' or '`')
            {
                // A quoted identifier: no backslash escapes, a doubled quote is an escaped quote.
                var end = AfterString(sql, index, character, backslashEscapes: false);
                var body = sql[(index + 1)..Math.Max(index + 1, end - 1)];
                current.Append(character).Append(body.Replace(new string(character, 2), EscapedBacktick.ToString())).Append(character);
                index = end;
                continue;
            }

            if (character == '$' && !mysql && (index == 0 || !(char.IsLetterOrDigit(sql[index - 1]) || sql[index - 1] is '_' or '$')))
            {
                var tag = DollarQuote().Match(sql[index..Math.Min(sql.Length, index + 64)]);
                if (tag.Success)
                {
                    var close = sql.IndexOf(tag.Value, index + tag.Length, StringComparison.Ordinal);
                    index = close == -1 ? sql.Length : close + tag.Length;
                    current.Append(" 's' ");
                    continue;
                }
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

    private static void Flush(List<string> statements, StringBuilder current)
    {
        var text = current.ToString().Trim();
        if (text.Length > 0)
        {
            statements.Add(text);
        }

        current.Clear();
    }

    /// <summary>The index after the quoted text opened at <paramref name="start"/>, or the end if it never closes.</summary>
    private static int AfterString(string sql, int start, char quote, bool backslashEscapes)
    {
        var index = start + 1;
        while (index < sql.Length)
        {
            if (backslashEscapes && sql[index] == '\\')
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
