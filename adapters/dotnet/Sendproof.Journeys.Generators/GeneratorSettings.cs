using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Diagnostics;

namespace Sendproof.Journeys.Generators;

/// <summary>Where and under what name to generate: from the assembly attribute, MSBuild properties and the assembly name.</summary>
/// <param name="Enabled">Whether the compilation references Sendproof.Journeys.</param>
/// <param name="Namespace">The root namespace.</param>
/// <param name="ClassName">The operations class name.</param>
/// <param name="ProjectDirectory">The project directory, to make journey file paths relative.</param>
internal sealed record GeneratorSettings(bool Enabled, string Namespace, string ClassName, string ProjectDirectory)
{
    private const string AttributeName = "Sendproof.Journeys.JourneyOperationsAttribute";

    public static GeneratorSettings From(Compilation compilation, AnalyzerConfigOptions options)
    {
        var assemblyName = compilation.AssemblyName ?? "App";
        options.TryGetValue("build_property.RootNamespace", out var rootNamespace);
        options.TryGetValue("build_property.SendproofOperationsClass", out var property);
        options.TryGetValue("build_property.ProjectDir", out var projectDirectory);
        var attribute = compilation.Assembly.GetAttributes()
            .FirstOrDefault(data => data.AttributeClass?.ToDisplayString() == AttributeName)?
            .ConstructorArguments.FirstOrDefault().Value as string;
        var className = !string.IsNullOrWhiteSpace(attribute) ? attribute!
            : !string.IsNullOrWhiteSpace(property) ? property!
            : Names.Identifier(assemblyName.Split('.').Last()) + "Operations";
        return new GeneratorSettings(
            compilation.GetTypeByMetadataName("Sendproof.Journeys.JourneyOperation`2") is not null,
            string.IsNullOrWhiteSpace(rootNamespace) ? assemblyName : rootNamespace!,
            className,
            projectDirectory ?? "");
    }
}
