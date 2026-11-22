using System.ComponentModel.DataAnnotations;

namespace StoreApi;

/// <summary>A person who can sign in to the store's back office or storefront.</summary>
public sealed class User
{
    /// <summary>The user's numeric ID.</summary>
    public required int Id { get; init; }
    /// <summary>The user's sign-in email address.</summary>
    public required string Email { get; init; }
    /// <summary>The user's display name.</summary>
    public required string Name { get; init; }
    /// <summary>The role that decides what the user may do.</summary>
    public required RoleName Role { get; init; }
    /// <summary>The user's job title. Absent for customers.</summary>
    public string? JobTitle { get; init; }
    /// <summary>Whether the user can sign in.</summary>
    public required bool IsActive { get; init; }
}

/// <summary>A role and what it allows.</summary>
public sealed class Role
{
    /// <summary>The role's name, as it appears on users and in security requirements.</summary>
    public required RoleName Name { get; init; }
    /// <summary>What the role is for.</summary>
    public required string Description { get; init; }
    /// <summary>The kinds of action the role allows, in plain words.</summary>
    public required IReadOnlyList<string> Permissions { get; init; }
    /// <summary>How many users currently hold the role.</summary>
    public required int UserCount { get; init; }
}

/// <summary>The new role for a user.</summary>
public sealed class ChangeRoleRequest
{
    /// <summary>The role to grant. It replaces the user's current role.</summary>
    [Required] public RoleName Role { get; set; } = RoleName.Customer;
}
