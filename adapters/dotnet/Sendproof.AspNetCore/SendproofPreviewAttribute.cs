namespace Sendproof.AspNetCore;

/// <summary>Declares an MVC action or all actions on a controller safe for rollback preview, or marks one unavailable for it.</summary>
/// <remarks>
/// Apply this attribute only when the affected operations enlist their writes in the configured provider
/// transaction and suppress external effects. The host's authorization policies still apply.
/// <para>
/// <c>[SendproofPreview(Enabled = false, Reason = "...")]</c> marks an operation <c>preview: false</c>: the workbench
/// shows "Preview unavailable" with the reason before anyone runs it, a Preview of it never runs the handler, and
/// ordinary Send and observed Send are unaffected. Sendproof never infers this mark from code.
/// </para>
/// </remarks>
[AttributeUsage(AttributeTargets.Class | AttributeTargets.Method, Inherited = true)]
public sealed class SendproofPreviewAttribute : Attribute
{
    /// <summary>
    /// Gets or sets whether the operation can be previewed. <see langword="false"/> advertises it as unavailable
    /// instead. The default is <see langword="true"/>.
    /// </summary>
    public bool Enabled { get; set; } = true;

    /// <summary>Gets or sets the sentence the workbench shows for an unavailable operation, such as "Clears the Redis session".</summary>
    public string? Reason { get; set; }

    /// <summary>Gets or sets the store ids the operation writes to (<c>redis</c>, <c>mongodb</c>, <c>dynamodb</c>), shown beside the reason.</summary>
    public string[]? Stores { get; set; }
}
