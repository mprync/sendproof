using System.Globalization;
using System.Text.Json.Nodes;

namespace Sendproof.Journeys;

/// <summary>A Redis key, fixed or built from refs: <c>RedisKey.Format("cart:{0}:quote", cartId)</c>.</summary>
public sealed class RedisKey
{
    private readonly string _text;

    private RedisKey(JourneyValue value, string text)
    {
        Value = value;
        _text = text;
    }

    internal JourneyValue Value { get; }

    /// <summary>
    /// Builds a key from a composite format. Each ref becomes <c>{$expression}</c> in the expectations document, which
    /// the runner substitutes; any other part is written as invariant text.
    /// </summary>
    public static RedisKey Format(string format, params object[] parts)
    {
        ArgumentException.ThrowIfNullOrEmpty(format);
        ArgumentNullException.ThrowIfNull(parts);
        var references = parts.OfType<IRef>().Select(part => part.Source).ToList();
        var text = string.Format(CultureInfo.InvariantCulture, format, parts.Select(part => part is IRef r ? $"{{{r.Source.Describe()}}}" : part).ToArray());
        return new RedisKey(JourneyValue.Of(context => JsonValue.Create(string.Format(CultureInfo.InvariantCulture, format,
            parts.Select(part => part is IRef r ? $"{{{r.Source.Expression(context.Json)}}}" : Convert.ToString(part, CultureInfo.InvariantCulture)).ToArray())),
            references), text);
    }

    /// <summary>A fixed key.</summary>
    public static implicit operator RedisKey(string key)
    {
        ArgumentException.ThrowIfNullOrEmpty(key);
        return new RedisKey(JourneyValue.Literal(key, typeof(string)), key);
    }

    /// <inheritdoc />
    public override string ToString() => _text;
}
