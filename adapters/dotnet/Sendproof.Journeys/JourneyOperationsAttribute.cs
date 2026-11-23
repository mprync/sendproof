namespace Sendproof.Journeys;

/// <summary>
/// Names the operations class the generator writes for this assembly, such as
/// <c>[assembly: JourneyOperations("StoreOperations")]</c>. Without it the class is named after the assembly
/// (<c>StoreApiOperations</c>), or after the <c>SendproofOperationsClass</c> MSBuild property when that is set.
/// </summary>
[AttributeUsage(AttributeTargets.Assembly)]
public sealed class JourneyOperationsAttribute(string className) : Attribute
{
    /// <summary>Gets the class name.</summary>
    public string ClassName { get; } = className;
}
