using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Text;

namespace Sendproof.Journeys.Generators;

/// <summary>A source location without the syntax tree, so it can sit in a cached pipeline value.</summary>
internal sealed record LocationInfo(string FilePath, TextSpan Span, LinePositionSpan Lines)
{
    public static LocationInfo From(SyntaxNode node)
    {
        var location = node.GetLocation();
        return new LocationInfo(location.SourceTree?.FilePath ?? "", location.SourceSpan, location.GetLineSpan().Span);
    }

    public Location ToLocation() => Location.Create(FilePath, Span, Lines);
}
