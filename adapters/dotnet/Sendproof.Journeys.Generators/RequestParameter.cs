namespace Sendproof.Journeys.Generators;

/// <summary>One member of a generated request class.</summary>
/// <param name="Name">The name on the wire: the route, query or header name. Empty for the body.</param>
/// <param name="Property">The C# property name.</param>
/// <param name="Source">The ASP.NET Core attribute that says where it goes: <c>FromRoute</c>, <c>FromQuery</c>, <c>FromHeader</c> or <c>FromBody</c>.</param>
/// <param name="Type">The fully qualified type, with its nullability.</param>
/// <param name="NeedsValue">Whether the type is a non-nullable reference type, which the property initialises to <c>default!</c>.</param>
internal sealed record RequestParameter(string Name, string Property, string Source, string Type, bool NeedsValue);
