using System.Reflection;

namespace Sendproof.Journeys;

/// <summary>One step of a <see cref="MemberPath"/>: a member of <paramref name="Container"/>, or an index into it.</summary>
internal sealed record PathSegment(Type Container, MemberInfo? Member, int? Index);
