namespace Sendproof.Journeys;

/// <summary>
/// One API operation a step can call, with the app's own request and response types. The operations catalog (such as
/// <c>StoreOperations</c>) is generated from the app's <c>Map*</c> calls, so a renamed or removed endpoint is a
/// compile error in the journeys that use it.
/// </summary>
/// <typeparam name="TRequest">The operation's path, query and header parameters, and its <c>Body</c>.</typeparam>
/// <typeparam name="TResponse">The type of the operation's successful response body.</typeparam>
public sealed class JourneyOperation<TRequest, TResponse>
{
    /// <summary>Creates an operation. The generated catalog calls this; journeys use its members.</summary>
    /// <param name="operationId">The OpenAPI operationId: the endpoint's <c>WithName</c>.</param>
    /// <param name="method">The HTTP method.</param>
    public JourneyOperation(string operationId, string method)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(operationId);
        ArgumentException.ThrowIfNullOrWhiteSpace(method);
        OperationId = operationId;
        Method = method;
    }

    /// <summary>Gets the OpenAPI operationId.</summary>
    public string OperationId { get; }

    /// <summary>Gets the HTTP method.</summary>
    public string Method { get; }

    /// <inheritdoc />
    public override string ToString() => $"{Method} {OperationId}";
}
