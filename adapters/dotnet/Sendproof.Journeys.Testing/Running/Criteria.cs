using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Bielu.Arazzo.Models;
using Json.Path;

namespace Sendproof.Journeys.Testing;

/// <summary>
/// Checks Arazzo success criteria. Simple conditions (<c>$statusCode == 201 &amp;&amp; $response.body#/status == 'Shipped'</c>)
/// are parsed here, as no library evaluates Arazzo's condition syntax; regex criteria use .NET regular expressions and
/// JSONPath criteria JsonPath.Net.
/// </summary>
internal static class Criteria
{
    internal static JourneyCriterionResult Check(ArazzoCriterion criterion, ExpressionContext context)
    {
        var condition = criterion.Condition ?? "";
        switch (criterion.Type?.Type)
        {
            case "regex":
                var text = Interpolation.Text(context.Evaluate(criterion.Context!));
                return new JourneyCriterionResult(condition, Regex.IsMatch(text, condition), JsonValue.Create(text));
            case "jsonpath":
                var node = context.Evaluate(criterion.Context!);
                var matches = JsonPath.Parse(condition).Evaluate(node).Matches;
                return new JourneyCriterionResult(condition, matches.Count > 0, node);
            default:
                var parser = new Parser(condition, context);
                var passed = parser.Or();
                return new JourneyCriterionResult(condition, passed, parser.FirstOperand);
        }
    }

    /// <summary>A recursive-descent parser of simple conditions: <c>||</c>, <c>&amp;&amp;</c>, parentheses and the six comparisons.</summary>
    private sealed class Parser(string text, ExpressionContext context)
    {
        private int _position;
        private bool _readFirst;

        internal JsonNode? FirstOperand { get; private set; }

        internal bool Or()
        {
            var result = And();
            while (Take("||"))
            {
                result = And() | result;
            }

            return result;
        }

        private bool And()
        {
            var result = Comparison();
            while (Take("&&"))
            {
                result = Comparison() & result;
            }

            return result;
        }

        private bool Comparison()
        {
            if (Take("("))
            {
                var inner = Or();
                Take(")");
                return inner;
            }

            var left = Operand();
            var op = new[] { "==", "!=", "<=", ">=", "<", ">" }.FirstOrDefault(Take);
            if (op is null)
            {
                return left?.GetValueKind() == JsonValueKind.True;
            }

            var right = Operand();
            if (op is "==" or "!=")
            {
                return JsonValues.Equal(left, right) == (op == "==");
            }

            var order = Compare(left, right);
            return order is { } value && op switch { "<" => value < 0, "<=" => value <= 0, ">" => value > 0, _ => value >= 0 };
        }

        private JsonNode? Operand()
        {
            Skip();
            JsonNode? value;
            if (Peek() == '\'')
            {
                var end = _position + 1;
                var literal = new System.Text.StringBuilder();
                while (end < text.Length)
                {
                    if (text[end] == '\'' && end + 1 < text.Length && text[end + 1] == '\'')
                    {
                        literal.Append('\'');
                        end += 2;
                    }
                    else if (text[end] == '\'')
                    {
                        break;
                    }
                    else
                    {
                        literal.Append(text[end++]);
                    }
                }

                _position = end + 1;
                value = JsonValue.Create(literal.ToString());
            }
            else
            {
                var start = _position;
                while (_position < text.Length && !char.IsWhiteSpace(text[_position]) && text[_position] is not ('=' or '!' or '<' or '>' or '&' or '|' or ')'))
                {
                    _position++;
                }

                var token = text[start.._position];
                value = token.StartsWith('$') ? context.Evaluate(token)
                    : token switch
                    {
                        "true" => JsonValue.Create(true),
                        "false" => JsonValue.Create(false),
                        "null" => null,
                        _ => decimal.TryParse(token, NumberStyles.Float, CultureInfo.InvariantCulture, out var number) ? JsonValue.Create(number) : JsonValue.Create(token)
                    };
            }

            if (!_readFirst)
            {
                _readFirst = true;
                FirstOperand = value?.DeepClone();
            }

            return value;
        }

        private static int? Compare(JsonNode? left, JsonNode? right)
        {
            if (left?.GetValueKind() == JsonValueKind.Number && right?.GetValueKind() == JsonValueKind.Number)
            {
                return left.GetValue<decimal>().CompareTo(right.GetValue<decimal>());
            }

            return JsonValues.String(left) is { } a && JsonValues.String(right) is { } b ? string.CompareOrdinal(a, b) : null;
        }

        private bool Take(string token)
        {
            Skip();
            if (string.CompareOrdinal(text, _position, token, 0, token.Length) != 0)
            {
                return false;
            }

            _position += token.Length;
            return true;
        }

        private char Peek() => _position < text.Length ? text[_position] : '\0';

        private void Skip()
        {
            while (_position < text.Length && char.IsWhiteSpace(text[_position]))
            {
                _position++;
            }
        }
    }
}
