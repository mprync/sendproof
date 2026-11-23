using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Sendproof.AspNetCore;

namespace Sendproof.Journeys.EntityFrameworkCore;

/// <summary>
/// An entity's table, named as the EF Core change capture names it: the model's table name (with its schema), and each
/// property by its model name, with values written as the capture writes them.
/// </summary>
internal sealed class SqlTarget(Type contextType, Type entityType) : IWriteTarget
{
    public ResolvedTarget? Resolve(JourneyGeneration generation, ICollection<string> problems)
    {
        var entity = generation.Model(contextType).FindEntityType(entityType);
        if (entity is null)
        {
            problems.Add($"{entityType.Name} is not an entity of {contextType.Name}.");
            return null;
        }

        var table = entity.GetTableName() ?? entity.DisplayName();
        if (entity.GetSchema() is { } schema)
        {
            table = $"{schema}.{table}";
        }

        return new ResolvedTarget(generation.SqlStore, "table", table, path => entity.FindProperty(path.Root.Name) is { } property
            ? new ResolvedField(property.Name, (value, type) => JsonSerializer.SerializeToNode(value, type, PreviewProtocol.JsonOptions))
            : null);
    }
}
