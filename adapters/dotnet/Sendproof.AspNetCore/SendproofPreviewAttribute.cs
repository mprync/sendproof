namespace Sendproof.AspNetCore;

/// <summary>Declares an MVC action or all actions on a controller safe for rollback preview.</summary>
/// <remarks>
/// Apply this attribute only when the affected operations enlist their writes in the configured provider
/// transaction and suppress external effects. The host's authorization policies still apply.
/// </remarks>
[AttributeUsage(AttributeTargets.Class | AttributeTargets.Method, Inherited = true)]
public sealed class SendproofPreviewAttribute : Attribute;
