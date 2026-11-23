using System.Linq.Expressions;
using Microsoft.EntityFrameworkCore;

namespace Sendproof.Journeys.EntityFrameworkCore;

/// <summary>
/// The rows a step should write through a <typeparamref name="TDbContext"/>. Tables are the context's own sets and
/// columns its entities' properties, so table and field names in the expectations come from the EF Core model.
/// </summary>
/// <typeparam name="TDbContext">The app's DbContext.</typeparam>
public sealed class SqlWrites<TDbContext> where TDbContext : DbContext
{
    private readonly StepWrites _writes;

    internal SqlWrites(StepWrites writes) => _writes = writes;

    /// <summary>The step inserts a row into this table, such as <c>Insert(db =&gt; db.Shipments)</c>.</summary>
    public WriteExpectation<TEntity> Insert<TEntity>(Expression<Func<TDbContext, DbSet<TEntity>>> table) where TEntity : class =>
        Add(table, "insert");

    /// <summary>The step updates a row of this table, found by its <c>Where</c> key.</summary>
    public WriteExpectation<TEntity> Update<TEntity>(Expression<Func<TDbContext, DbSet<TEntity>>> table) where TEntity : class =>
        Add(table, "update");

    /// <summary>The step deletes a row of this table, found by its <c>Where</c> key.</summary>
    public WriteExpectation<TEntity> Delete<TEntity>(Expression<Func<TDbContext, DbSet<TEntity>>> table) where TEntity : class =>
        Add(table, "delete");

    private WriteExpectation<TEntity> Add<TEntity>(Expression<Func<TDbContext, DbSet<TEntity>>> table, string operation) where TEntity : class
    {
        // The set only picks the entity type; the model names its table.
        ArgumentNullException.ThrowIfNull(table);
        var write = new FieldWrite(new SqlTarget(typeof(TDbContext), typeof(TEntity)), operation);
        _writes.Add(write);
        return new WriteExpectation<TEntity>(_writes, write);
    }
}
