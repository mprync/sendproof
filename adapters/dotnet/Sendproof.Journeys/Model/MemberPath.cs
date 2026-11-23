using System.Linq.Expressions;
using System.Reflection;
using System.Text.Json;

namespace Sendproof.Journeys;

/// <summary>
/// A member chain read from a lambda, such as <c>r =&gt; r.Body.Lines[0].VariantId</c>: properties and constant indexes
/// only. Its JSON names are worked out later from the app's serializer options, so <c>[JsonPropertyName]</c> and the
/// naming policy are honoured exactly as they are on the wire.
/// </summary>
internal sealed class MemberPath
{
    private MemberPath(IReadOnlyList<PathSegment> segments, string text, Type valueType)
    {
        Segments = segments;
        Text = text;
        ValueType = valueType;
    }

    internal IReadOnlyList<PathSegment> Segments { get; }

    /// <summary>Gets the C# text of the lambda's body, for messages.</summary>
    internal string Text { get; }

    /// <summary>Gets the type of the value the path reads.</summary>
    internal Type ValueType { get; }

    /// <summary>Gets the first member, which is the request parameter, entity property or input it starts from.</summary>
    internal MemberInfo Root => Segments[0].Member ?? throw new JourneyDefinitionException($"{Text} starts with an index.");

    internal static MemberPath Parse(LambdaExpression lambda)
    {
        var segments = new List<PathSegment>();
        var expression = lambda.Body;
        while (true)
        {
            switch (expression)
            {
                case UnaryExpression { NodeType: ExpressionType.Convert or ExpressionType.ConvertChecked } conversion:
                    expression = conversion.Operand;
                    continue;
                case MemberExpression { Expression: { } owner, Member: PropertyInfo or FieldInfo } member:
                    segments.Insert(0, new PathSegment(owner.Type, member.Member, null));
                    expression = owner;
                    continue;
                case MethodCallExpression { Method.Name: "get_Item", Object: { } list, Arguments: [ConstantExpression { Value: int index }] }:
                    segments.Insert(0, new PathSegment(list.Type, null, index));
                    expression = list;
                    continue;
                case BinaryExpression { NodeType: ExpressionType.ArrayIndex, Right: ConstantExpression { Value: int index } } array:
                    segments.Insert(0, new PathSegment(array.Left.Type, null, index));
                    expression = array.Left;
                    continue;
                case ParameterExpression parameter when parameter == lambda.Parameters[0] && segments.Count > 0:
                    return new MemberPath(segments, lambda.Body.ToString(), lambda.Body.Type);
                default:
                    throw new JourneyDefinitionException(
                        $"{lambda} must read members and constant indexes only, such as r => r.Body.Lines[0].VariantId.");
            }
        }
    }

    /// <summary>The JSON name of each segment; an index stays a number.</summary>
    internal IReadOnlyList<string> Names(JsonSerializerOptions json) => Segments.Select(segment => segment.Member is { } member
        ? JsonName(segment.Container, member, json)
        : segment.Index!.Value.ToString(System.Globalization.CultureInfo.InvariantCulture)).ToList();

    /// <summary>The JSON pointer to the value, such as <c>/lines/0/variantId</c>.</summary>
    internal string Pointer(JsonSerializerOptions json, int skip = 0) =>
        string.Concat(Names(json).Skip(skip).Select(name => "/" + name.Replace("~", "~0").Replace("/", "~1")));

    /// <summary>The name a member has in JSON written with these options.</summary>
    internal static string JsonName(Type container, MemberInfo member, JsonSerializerOptions json)
    {
        try
        {
            var property = json.GetTypeInfo(container).Properties
                .FirstOrDefault(property => property.AttributeProvider is MemberInfo declared && declared.Name == member.Name);
            if (property is not null)
            {
                return property.Name;
            }
        }
        catch (Exception exception) when (exception is InvalidOperationException or NotSupportedException)
        {
            // A type the serializer can't describe still gets the naming policy's name.
        }

        return json.PropertyNamingPolicy?.ConvertName(member.Name) ?? member.Name;
    }

    /// <inheritdoc />
    public override string ToString() => Text;
}
