using System.Text;
using System.Text.RegularExpressions;

namespace Sendproof.AspNetCore;

/// <summary>A guarded command's kind and the <c>db.operation.name</c> the <c>Db</c> entry and the 409 body use.</summary>
internal readonly record struct Classification(CommandKind Kind, string Operation);

/// <summary>
/// What the guard needs to know about the text of one CQL or SQL statement: its first two words, and whether the text
/// holds more than one statement. Text the scanner can't read (an unterminated quote or comment) is
/// <see cref="Broken"/>, and a broken statement is never a read.
/// </summary>
internal readonly record struct StatementShape(string First, string Second, bool Multiple, bool Broken)
{
    /// <summary>The dialect switches: which quote characters and comments the statement language has.</summary>
    internal readonly record struct Dialect(bool Backticks = false, bool Dollar = false, bool SlashComments = false);

    /// <summary>CQL: <c>$$…$$</c> strings and <c>//</c> comments.</summary>
    internal static readonly Dialect Cql = new(Dollar: true, SlashComments: true);

    /// <summary>The Elasticsearch and OpenSearch SQL endpoints: backtick-quoted names.</summary>
    internal static readonly Dialect Sql = new(Backticks: true);

    /// <summary>
    /// Reads the first two words (upper case) after whitespace and comments, then walks the rest of the text, skipping
    /// quoted strings and comments, to see whether a second statement follows a semicolon. Quotes are <c>'…'</c> and
    /// <c>"…"</c> with doubled-quote escapes; <paramref name="dialect"/> adds the others.
    /// </summary>
    internal static StatementShape Of(string? text, Dialect dialect)
    {
        var source = text ?? "";
        var index = 0;

        bool SkipComment()
        {
            if (string.CompareOrdinal(source, index, "--", 0, 2) == 0 || (dialect.SlashComments && string.CompareOrdinal(source, index, "//", 0, 2) == 0))
            {
                var end = source.IndexOf('\n', index);
                index = end < 0 ? source.Length : end + 1;
                return true;
            }

            if (string.CompareOrdinal(source, index, "/*", 0, 2) == 0)
            {
                var end = source.IndexOf("*/", index + 2, StringComparison.Ordinal);
                if (end < 0)
                {
                    throw new FormatException("unterminated comment");
                }

                index = end + 2;
                return true;
            }

            return false;
        }

        void SkipBlank()
        {
            while (true)
            {
                while (index < source.Length && char.IsWhiteSpace(source[index])) index++;
                if (!SkipComment()) return;
            }
        }

        string Word()
        {
            SkipBlank();
            var start = index;
            while (index < source.Length && (char.IsAsciiLetter(source[index]) || source[index] == '_')) index++;
            return source[start..index].ToUpperInvariant();
        }

        try
        {
            var first = Word();
            var second = Word();
            var multiple = false;
            while (index < source.Length)
            {
                if (SkipComment()) continue;
                var character = source[index];
                string? quote = character is '\'' or '"' || (dialect.Backticks && character == '`')
                    ? character.ToString()
                    : dialect.Dollar && string.CompareOrdinal(source, index, "$$", 0, 2) == 0 ? "$$" : null;
                if (quote is not null)
                {
                    var end = index + quote.Length;
                    while (true)
                    {
                        end = source.IndexOf(quote, end, StringComparison.Ordinal);
                        if (end < 0)
                        {
                            throw new FormatException("unterminated quote");
                        }

                        if (quote != "$$" && end + 1 < source.Length && source[end + 1] == quote[0])
                        {
                            end += 2;
                            continue;
                        }

                        break;
                    }

                    index = end + quote.Length;
                    continue;
                }

                index++;
                if (character == ';')
                {
                    SkipBlank();
                    multiple = index < source.Length;
                    break;
                }
            }

            return new StatementShape(first, second, multiple, false);
        }
        catch (FormatException)
        {
            return new StatementShape("", "", false, true);
        }
    }

    /// <summary>
    /// Replaces every literal in CQL, SQL or PartiQL text with <c>?</c>: quoted strings (<c>'…'</c> with <c>''</c>
    /// escapes, and CQL's <c>$$…$$</c>), numbers, hexadecimal blobs and UUIDs. Double-quoted identifiers stay as written.
    /// A statement may inline values instead of using bind markers, and a value never appears in a <c>Db</c> entry.
    /// </summary>
    internal static string Redact(string text)
    {
        var output = new StringBuilder(text.Length);
        var index = 0;
        while (index < text.Length)
        {
            var character = text[index];
            if (character == '"')
            {
                var end = text.IndexOf('"', index + 1);
                var stop = end < 0 ? text.Length : end + 1;
                output.Append(text, index, stop - index);
                index = stop;
            }
            else if (character == '\'')
            {
                var end = index + 1;
                while (end < text.Length && !(text[end] == '\'' && (end + 1 >= text.Length || text[end + 1] != '\'')))
                {
                    end += text[end] == '\'' && end + 1 < text.Length ? 2 : 1;
                }

                output.Append('?');
                index = end + 1;
            }
            else if (string.CompareOrdinal(text, index, "$$", 0, 2) == 0)
            {
                var end = text.IndexOf("$$", index + 2, StringComparison.Ordinal);
                output.Append('?');
                index = end < 0 ? text.Length : end + 2;
            }
            else if ((index == 0 || !IsWordPart(text[index - 1])) && Literal.Match(text, index) is { Success: true, Length: > 0 } match)
            {
                output.Append('?');
                index += match.Length;
            }
            else
            {
                output.Append(character);
                index++;
            }
        }

        return output.ToString();
    }

    /// <summary>
    /// Replaces every value in JSON text (a search body, a protobuf message rendered as JSON) with <c>"?"</c>, keeping field
    /// names and structure; one line per NDJSON line. Text that is not JSON becomes a bare <c>"?"</c>.
    /// </summary>
    internal static string? RedactJson(string? json) => ElasticsearchClassifier.Statement(json);

    private static bool IsWordPart(char character) => char.IsAsciiLetterOrDigit(character) || character is '_' or '.' or '"';

    // A UUID, a hexadecimal blob or a number, at a word boundary; a leading minus belongs to the number.
    private static readonly Regex Literal = new(
        @"\G(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|0[xX][0-9a-fA-F]*|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(?![\w])",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);
}
