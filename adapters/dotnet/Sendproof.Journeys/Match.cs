using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Sendproof.Journeys;

/// <summary>Matchers for expected values that can't be known in advance.</summary>
public static class Match
{
    /// <summary>Any value of the type: <c>{ "type": "date-time" }</c> for a date, <c>uuid</c> for a <see cref="Guid"/>, and so on.</summary>
    public static Matcher<T> Any<T>() => new(_ => new JsonObject { ["type"] = TypeName(typeof(T)) });

    /// <summary>A string matching a regular expression (ECMAScript flavour, as the workbench evaluates it).</summary>
    public static Matcher<string> Pattern(string pattern)
    {
        ArgumentException.ThrowIfNullOrEmpty(pattern);
        try
        {
            _ = new Regex(pattern, RegexOptions.ECMAScript);
        }
        catch (ArgumentException exception)
        {
            throw new ArgumentException($"{pattern} is not a valid regular expression: {exception.Message}", nameof(pattern), exception);
        }

        return new(_ => new JsonObject { ["pattern"] = pattern });
    }

    /// <summary>An update that changes the value from <paramref name="from"/> to <paramref name="to"/>.</summary>
    public static Matcher<T> Changed<T>(T from, T to) => new(context => new JsonObject
    {
        ["from"] = context.Serialize(from, typeof(T)),
        ["to"] = context.Serialize(to, typeof(T))
    });

    private static string TypeName(Type type)
    {
        type = Nullable.GetUnderlyingType(type) ?? type;
        if (type == typeof(DateTimeOffset) || type == typeof(DateTime))
        {
            return "date-time";
        }

        if (type == typeof(Guid))
        {
            return "uuid";
        }

        if (type == typeof(string) || type.IsEnum)
        {
            return "string";
        }

        if (type == typeof(bool))
        {
            return "boolean";
        }

        return Type.GetTypeCode(type) switch
        {
            TypeCode.Byte or TypeCode.SByte or TypeCode.Int16 or TypeCode.UInt16 or TypeCode.Int32 or TypeCode.UInt32
                or TypeCode.Int64 or TypeCode.UInt64 => "integer",
            TypeCode.Single or TypeCode.Double or TypeCode.Decimal => "number",
            _ => "any"
        };
    }
}
