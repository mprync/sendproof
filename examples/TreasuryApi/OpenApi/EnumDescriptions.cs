using System.ComponentModel;
using System.Reflection;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace TreasuryApi;

/// <summary>
/// Reads the <see cref="DescriptionAttribute"/> on enum members and turns them into the <c>x-enum-descriptions</c>
/// OpenAPI extension: a map from each wire value to a short description the workbench shows beside the value.
/// </summary>
internal static class EnumDescriptions
{
    /// <summary>The extension name added to enum schemas and to inline enums of properties and parameters.</summary>
    internal const string Extension = "x-enum-descriptions";

    /// <summary>
    /// Builds the value-to-description map of an enum, keyed by the value the API sends (a
    /// <see cref="JsonStringEnumMemberNameAttribute"/> wins over the member name).
    /// Returns <see langword="null"/> when no member has a description.
    /// </summary>
    internal static JsonObject? For(Type enumType)
    {
        enumType = Nullable.GetUnderlyingType(enumType) ?? enumType;
        if (!enumType.IsEnum) return null;
        var map = new JsonObject();
        foreach (var field in enumType.GetFields(BindingFlags.Public | BindingFlags.Static))
        {
            var description = field.GetCustomAttribute<DescriptionAttribute>()?.Description;
            if (description is null) continue;
            var wire = field.GetCustomAttribute<JsonStringEnumMemberNameAttribute>()?.Name ?? field.Name;
            map[wire] = description;
        }
        return map.Count == 0 ? null : map;
    }
}
