using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Sendproof.Journeys.Generators;

/// <summary>
/// Reads a minimal-API <c>Map*</c> call: its method and route (following <c>MapGroup</c> prefixes held in locals),
/// the <c>WithName</c>, <c>WithTags</c> and <c>Produces&lt;T&gt;</c> calls chained on it, and its handler's parameters.
/// </summary>
internal static class EndpointReader
{
    private const string Extensions = "Microsoft.AspNetCore.Builder.EndpointRouteBuilderExtensions";
    private static readonly Regex RouteParameter = new(@"\{\*{0,2}([A-Za-z0-9_]+)", RegexOptions.Compiled);

    private static readonly SymbolDisplayFormat TypeFormat = SymbolDisplayFormat.FullyQualifiedFormat.WithMiscellaneousOptions(
        SymbolDisplayFormat.FullyQualifiedFormat.MiscellaneousOptions | SymbolDisplayMiscellaneousOptions.IncludeNullableReferenceTypeModifier);

    // Types minimal APIs bind from the request context or services, never from the request itself.
    private static readonly HashSet<string> ContextTypes =
    [
        "System.Threading.CancellationToken", "System.Security.Claims.ClaimsPrincipal", "Microsoft.AspNetCore.Http.HttpContext",
        "Microsoft.AspNetCore.Http.HttpRequest", "Microsoft.AspNetCore.Http.HttpResponse", "System.IO.Stream", "System.IO.Pipelines.PipeReader",
        "Microsoft.AspNetCore.Http.IFormFile", "Microsoft.AspNetCore.Http.IFormFileCollection", "Microsoft.AspNetCore.Http.IFormCollection"
    ];

    public static bool IsCandidate(SyntaxNode node) => node is InvocationExpressionSyntax
    {
        Expression: MemberAccessExpressionSyntax { Name.Identifier.ValueText: "MapGet" or "MapPost" or "MapPut" or "MapPatch" or "MapDelete" },
        ArgumentList.Arguments.Count: >= 2
    };

    public static EndpointInfo? Read(GeneratorSyntaxContext context, CancellationToken cancellationToken)
    {
        var invocation = (InvocationExpressionSyntax)context.Node;
        var model = context.SemanticModel;
        var access = (MemberAccessExpressionSyntax)invocation.Expression;
        var resolved = model.GetSymbolInfo(invocation, cancellationToken);
        var target = resolved.Symbol as IMethodSymbol ?? resolved.CandidateSymbols.OfType<IMethodSymbol>().FirstOrDefault();
        if (target?.ContainingType?.ToDisplayString() != Extensions)
        {
            return null;
        }

        var method = access.Name.Identifier.ValueText.Substring("Map".Length).ToUpperInvariant();
        var arguments = invocation.ArgumentList.Arguments;
        var route = Combine(Prefix(model, access.Expression, cancellationToken), Constant(model, arguments[0].Expression) as string ?? "");
        string? name = null;
        string? response = null;
        SyntaxNode node = invocation;
        while (node.Parent is MemberAccessExpressionSyntax chained && chained.Expression == node && chained.Parent is InvocationExpressionSyntax call)
        {
            switch (chained.Name)
            {
                case IdentifierNameSyntax { Identifier.ValueText: "WithName" } when call.ArgumentList.Arguments.Count == 1:
                    name = Constant(model, call.ArgumentList.Arguments[0].Expression) as string;
                    break;
                case GenericNameSyntax { Identifier.ValueText: "Produces", TypeArgumentList.Arguments.Count: 1 } produces when response is null:
                    var status = call.ArgumentList.Arguments.Count > 0 ? Constant(model, call.ArgumentList.Arguments[0].Expression) as int? : 200;
                    if (status is >= 200 and < 300 && model.GetTypeInfo(produces.TypeArgumentList.Arguments[0], cancellationToken).Type is { } type)
                    {
                        response = type.ToDisplayString(TypeFormat);
                    }

                    break;
            }

            node = call;
        }

        var handlerInfo = model.GetSymbolInfo(arguments[1].Expression, cancellationToken);
        var handler = handlerInfo.Symbol as IMethodSymbol ?? handlerInfo.CandidateSymbols.OfType<IMethodSymbol>().FirstOrDefault();
        var parameters = handler is null ? [] : Parameters(handler, method, route);
        var implied = handler is { MethodKind: MethodKind.Ordinary } action
            ? $"{Trim(action.ContainingType.Name, "Endpoints")}.{action.Name}"
            : method.Substring(0, 1) + method.Substring(1).ToLowerInvariant() + Names.Identifier(RouteParameter.Replace(route, "By$1"));
        return new EndpointInfo(name, implied, method, route, new EquatableArray<RequestParameter>(parameters),
            response ?? "object", LocationInfo.From(invocation));
    }

    private static RequestParameter[] Parameters(IMethodSymbol handler, string method, string route)
    {
        var routeNames = new HashSet<string>(RouteParameter.Matches(route).Cast<System.Text.RegularExpressions.Match>().Select(match => match.Groups[1].Value),
            System.StringComparer.OrdinalIgnoreCase);
        var parameters = new List<RequestParameter>();
        var hasBody = false;
        foreach (var parameter in handler.Parameters)
        {
            var attributes = parameter.GetAttributes();
            string? Attribute(string attributeName, out string? boundName)
            {
                var data = attributes.FirstOrDefault(item => item.AttributeClass?.ToDisplayString() == attributeName);
                boundName = data?.NamedArguments.FirstOrDefault(argument => argument.Key == "Name").Value.Value as string;
                return data is null ? null : attributeName;
            }

            var type = parameter.Type.WithNullableAnnotation(parameter.NullableAnnotation).ToDisplayString(TypeFormat);
            var property = Names.Identifier(parameter.Name);
            var needsValue = parameter.Type.IsReferenceType && parameter.NullableAnnotation != NullableAnnotation.Annotated;
            if (Attribute("Microsoft.AspNetCore.Mvc.FromServicesAttribute", out _) is not null ||
                Attribute("Microsoft.Extensions.DependencyInjection.FromKeyedServicesAttribute", out _) is not null ||
                Attribute("Microsoft.AspNetCore.Http.AsParametersAttribute", out _) is not null)
            {
                continue;
            }

            if (Attribute("Microsoft.AspNetCore.Mvc.FromHeaderAttribute", out var header) is not null)
            {
                parameters.Add(new RequestParameter(header ?? parameter.Name, property, "FromHeader", type, needsValue));
            }
            else if (Attribute("Microsoft.AspNetCore.Mvc.FromQueryAttribute", out var query) is not null)
            {
                parameters.Add(new RequestParameter(query ?? parameter.Name, property, "FromQuery", type, needsValue));
            }
            else if (Attribute("Microsoft.AspNetCore.Mvc.FromRouteAttribute", out var routeName) is not null || routeNames.Contains(parameter.Name))
            {
                parameters.Add(new RequestParameter(routeName ?? parameter.Name, property, "FromRoute", type, needsValue));
            }
            else if (Attribute("Microsoft.AspNetCore.Mvc.FromBodyAttribute", out _) is not null ||
                !hasBody && method is "POST" or "PUT" or "PATCH" && !IsSimple(parameter.Type) && !IsContextOrService(parameter.Type))
            {
                // Without [FromBody], the body is the first parameter of a complex type that isn't a known context or
                // service type, as minimal APIs bind it; mark it [FromBody] when a service class comes first.
                parameters.RemoveAll(item => item.Source == "FromBody");
                parameters.Add(new RequestParameter("", "Body", "FromBody", type, needsValue));
                hasBody = true;
            }
            else if (IsSimple(parameter.Type))
            {
                parameters.Add(new RequestParameter(parameter.Name, property, "FromQuery", type, needsValue));
            }
        }

        return [.. parameters];
    }

    private static bool IsSimple(ITypeSymbol type)
    {
        if (type is INamedTypeSymbol { OriginalDefinition.SpecialType: SpecialType.System_Nullable_T } nullable)
        {
            type = nullable.TypeArguments[0];
        }

        if (type is IArrayTypeSymbol array)
        {
            return IsSimple(array.ElementType);
        }

        return type.TypeKind == TypeKind.Enum || type.SpecialType is >= SpecialType.System_Boolean and <= SpecialType.System_String ||
            type.SpecialType == SpecialType.System_DateTime ||
            type.ToDisplayString() is "System.Guid" or "System.DateTimeOffset" or "System.DateOnly" or "System.TimeOnly" or "System.TimeSpan" or "System.Uri";
    }

    private static bool IsContextOrService(ITypeSymbol type)
    {
        if (type.TypeKind == TypeKind.Interface || ContextTypes.Contains(type.ToDisplayString()))
        {
            return true;
        }

        for (var current = type.BaseType; current is not null; current = current.BaseType)
        {
            if (current.ToDisplayString() == "Microsoft.EntityFrameworkCore.DbContext")
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>The route prefix of the builder a <c>Map*</c> call is made on, following <c>MapGroup</c> calls and the locals that hold them.</summary>
    private static string Prefix(SemanticModel model, ExpressionSyntax receiver, CancellationToken cancellationToken)
    {
        for (var depth = 0; depth < 8; depth++)
        {
            switch (receiver)
            {
                case InvocationExpressionSyntax { Expression: MemberAccessExpressionSyntax access } invocation:
                    if (access.Name.Identifier.ValueText == "MapGroup" && invocation.ArgumentList.Arguments.Count == 1)
                    {
                        return Combine(Prefix(model, access.Expression, cancellationToken), Constant(model, invocation.ArgumentList.Arguments[0].Expression) as string ?? "");
                    }

                    receiver = access.Expression;
                    break;
                case IdentifierNameSyntax identifier when model.GetSymbolInfo(identifier, cancellationToken).Symbol is ILocalSymbol local &&
                    local.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax(cancellationToken) is VariableDeclaratorSyntax { Initializer.Value: { } value }:
                    receiver = value;
                    break;
                default:
                    return "";
            }
        }

        return "";
    }

    private static string Combine(string prefix, string pattern) =>
        "/" + string.Join("/", (prefix + "/" + pattern).Split(['/'], System.StringSplitOptions.RemoveEmptyEntries));

    private static object? Constant(SemanticModel model, ExpressionSyntax expression)
    {
        var value = model.GetConstantValue(expression);
        return value.HasValue ? value.Value : null;
    }

    private static string Trim(string text, string suffix) =>
        text.EndsWith(suffix) && text.Length > suffix.Length ? text.Substring(0, text.Length - suffix.Length) : text;
}
