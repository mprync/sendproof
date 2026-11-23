using System.Linq;
using System.Text;

namespace Sendproof.Journeys.Generators;

/// <summary>Turns endpoint names, parameter names and routes into C# identifiers.</summary>
internal static class Names
{
    /// <summary>A PascalCase identifier from any text: <c>idempotencyKey</c> and <c>Idempotency-Key</c> both give <c>IdempotencyKey</c>.</summary>
    public static string Identifier(string text)
    {
        var builder = new StringBuilder();
        var upper = true;
        foreach (var character in text)
        {
            if (char.IsLetterOrDigit(character) || character == '_')
            {
                builder.Append(upper ? char.ToUpperInvariant(character) : character);
                upper = false;
            }
            else
            {
                upper = true;
            }
        }

        var identifier = builder.ToString();
        return identifier.Length == 0 ? "Operation" : char.IsDigit(identifier[0]) ? "_" + identifier : identifier;
    }

    /// <summary>
    /// The group and member of an operation name: <c>OrdersController.Place</c> is <c>Orders</c> and <c>Place</c>; a
    /// name without a dot has no group.
    /// </summary>
    public static (string? Group, string Member) Split(string name)
    {
        var parts = name.Split('.');
        if (parts.Length == 1)
        {
            return (null, Identifier(name));
        }

        var group = string.Concat(parts.Take(parts.Length - 1).Select(Identifier));
        if (group.EndsWith("Controller") && group.Length > "Controller".Length)
        {
            group = group.Substring(0, group.Length - "Controller".Length);
        }

        return (group, Identifier(parts.Last()));
    }
}
