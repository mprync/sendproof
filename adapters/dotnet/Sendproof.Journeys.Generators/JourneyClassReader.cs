using System.Threading;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Sendproof.Journeys.Generators;

/// <summary>Finds the journey classes (non-abstract classes deriving from <c>Journey&lt;TInputs&gt;</c>) and their files.</summary>
internal static class JourneyClassReader
{
    public static bool IsCandidate(SyntaxNode node) => node is ClassDeclarationSyntax { BaseList: not null };

    public static JourneyClassInfo? Read(GeneratorSyntaxContext context, CancellationToken cancellationToken)
    {
        if (context.SemanticModel.GetDeclaredSymbol(context.Node, cancellationToken) is not INamedTypeSymbol { IsAbstract: false, IsGenericType: false } type)
        {
            return null;
        }

        for (var current = type.BaseType; current is not null; current = current.BaseType)
        {
            if (current.OriginalDefinition.ToDisplayString() == "Sendproof.Journeys.Journey<TInputs>")
            {
                return new JourneyClassInfo(type.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat), context.Node.SyntaxTree.FilePath);
            }
        }

        return null;
    }
}
