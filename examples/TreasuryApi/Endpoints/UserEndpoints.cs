using System.Security.Claims;
using Microsoft.EntityFrameworkCore;
using TestBench.AspNetCore;

namespace TreasuryApi;

/// <summary>The user and role operations: list users, read one, list roles and change a user's role.</summary>
internal static class UserEndpoints
{
    private static readonly Role[] RoleCatalogue =
    [
        new() { Name = RoleName.Admin, Description = "Administers accounts and users.", Permissions = ["Everything the other roles can do", "Register, change and close accounts", "Change other users' roles"], UserCount = 0 },
        new() { Name = RoleName.PaymentsApprove, Description = "Works payments: creates them and reviews other people's.", Permissions = ["Create, revise, submit and cancel payments", "Approve or reject payments created by someone else", "Add and archive counterparties", "Quote and book FX deals"], UserCount = 0 },
        new() { Name = RoleName.ReadOnly, Description = "Looks but cannot change anything.", Permissions = ["Read accounts, balances, payments, FX deals and statements"], UserCount = 0 }
    ];

    internal static void MapUserEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/v2/users").WithTags("Users and roles");
        group.MapGet("/", List).WithName("UsersController.List").RequireAuthorization()
            .WithMetadata(new SortKeysMetadata(SortKeys.Users)).Produces<PagedList<User>>().ProducesValidationProblem();
        group.MapGet("/{id:int}", Get).WithName("UsersController.Get").RequireAuthorization()
            .Produces<User>().ProducesProblem(StatusCodes.Status404NotFound);
        group.MapPut("/{id:int}/role", ChangeRole).WithName("UsersController.ChangeRole").RequireAuthorization(Policies.Admins)
            .Produces<User>().ProducesValidationProblem().ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity).WithTestBenchPreview();
        app.MapGet("/api/v2/roles", Roles).WithTags("Users and roles").WithName("UsersController.Roles").RequireAuthorization()
            .Produces<IReadOnlyList<Role>>();
    }

    /// <summary>List users</summary>
    /// <remarks>Returns the people who can sign in, sorted by name unless you pass `sort`.</remarks>
    /// <param name="page">The 1-based page number.</param>
    /// <param name="pageSize">How many users to return per page, from 1 to 100.</param>
    /// <param name="role">Only users with this role.</param>
    /// <param name="isActive">Only users who can (`true`) or cannot (`false`) sign in.</param>
    /// <param name="q">Search text matched against name, email and job title.</param>
    /// <param name="sort">The sort order: a field name, with a leading minus for descending. Defaults to `name`.</param>
    /// <response code="200">A page of users.</response>
    /// <response code="400">A paging or sort value was invalid.</response>
    internal static async Task<IResult> List(TreasuryDbContext db, int page = 1, int pageSize = EndpointSupport.DefaultPageSize,
        RoleName? role = null, bool? isActive = null, string? q = null, string? sort = null)
    {
        var errors = new Dictionary<string, string[]>();
        EndpointSupport.CheckPaging(page, pageSize, errors);
        EndpointSupport.CheckSort(sort, SortKeys.Users, errors);
        if (errors.Count > 0) return Results.ValidationProblem(errors);
        var query = db.Users.AsNoTracking().AsQueryable();
        if (role is { } r) { var claim = Mapping.ToRoleClaim(r); query = query.Where(u => u.Role == claim); }
        if (isActive is { } active) query = query.Where(u => u.IsActive == active);
        if (!string.IsNullOrWhiteSpace(q))
        {
            var pattern = EndpointSupport.LikePattern(q);
            query = query.Where(u => EF.Functions.Like(u.Name, pattern, "\\") || EF.Functions.Like(u.Email, pattern, "\\") ||
                EF.Functions.Like(u.JobTitle!, pattern, "\\"));
        }
        var ordered = (sort ?? "name") switch
        {
            "-name" => EndpointSupport.Sorted(query, true, u => u.Name, u => u.Id),
            "email" => EndpointSupport.Sorted(query, false, u => u.Email, u => u.Id),
            "-email" => EndpointSupport.Sorted(query, true, u => u.Email, u => u.Id),
            _ => EndpointSupport.Sorted(query, false, u => u.Name, u => u.Id)
        };
        return TypedResults.Ok(await EndpointSupport.PageAsync(ordered, page, pageSize,
            rows => Task.FromResult<IReadOnlyList<User>>(rows.Select(u => u.ToContract()).ToList())));
    }

    /// <summary>Get user</summary>
    /// <remarks>Returns one user with their role.</remarks>
    /// <param name="id">The user's numeric ID, from `UsersController.List`.</param>
    /// <response code="200">The user.</response>
    /// <response code="404">No user has this ID.</response>
    internal static async Task<IResult> Get(int id, TreasuryDbContext db) =>
        await db.Users.AsNoTracking().SingleOrDefaultAsync(u => u.Id == id) is { } user
            ? TypedResults.Ok(user.ToContract()) : EndpointSupport.NotFound("user", id);

    /// <summary>List roles</summary>
    /// <remarks>Returns the roles a user can hold, what each allows and how many users hold it. Change a user's role with `UsersController.ChangeRole`.</remarks>
    /// <response code="200">The roles.</response>
    internal static async Task<IResult> Roles(TreasuryDbContext db)
    {
        var counts = await db.Users.AsNoTracking().GroupBy(u => u.Role).Select(g => new { g.Key, Count = g.Count() }).ToDictionaryAsync(g => g.Key, g => g.Count);
        return TypedResults.Ok<IReadOnlyList<Role>>(RoleCatalogue.Select(r => new Role
        {
            Name = r.Name, Description = r.Description, Permissions = r.Permissions,
            UserCount = counts.GetValueOrDefault(Mapping.ToRoleClaim(r.Name))
        }).ToList());
    }

    /// <summary>Change user role</summary>
    /// <remarks>
    /// Replaces a user's role. The user is emailed and the change is published for access reviews. A signed-in
    /// session keeps its old role until the user signs in again.
    /// Requires the `admin` role. You cannot change your own role, and the last admin cannot be demoted.
    /// </remarks>
    /// <param name="id">The user's numeric ID.</param>
    /// <param name="request">The role to grant.</param>
    /// <response code="200">The user with the new role.</response>
    /// <response code="404">No user has this ID.</response>
    /// <response code="422">You tried to change your own role or demote the last admin.</response>
    internal static async Task<IResult> ChangeRole(int id, ChangeRoleRequest request, TreasuryDbContext db, ClaimsPrincipal principal,
        DemoNotificationQueue notifications, TestBenchPreview preview)
    {
        var user = await db.Users.SingleOrDefaultAsync(u => u.Id == id);
        if (user is null) return EndpointSupport.NotFound("user", id);
        if (string.Equals(user.Email, principal.Email(), StringComparison.OrdinalIgnoreCase))
            return EndpointSupport.Unprocessable("You cannot change your own role.");
        var previous = user.Role;
        var role = Mapping.ToRoleClaim(request.Role);
        if (previous == "admin" && role != "admin" && !await db.Users.AnyAsync(u => u.Role == "admin" && u.Id != id && u.IsActive))
            return EndpointSupport.Unprocessable("The last admin cannot be demoted.");
        user.Role = role;
        db.Audit("User", user.Id, $"User.RoleChanged: {previous} -> {role}", principal.Email());
        await db.SaveChangesAsync();
        notifications.RoleChanged(user, previous, preview);
        return TypedResults.Ok(user.ToContract());
    }
}
