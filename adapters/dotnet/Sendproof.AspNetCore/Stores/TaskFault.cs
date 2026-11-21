namespace Sendproof.AspNetCore;

/// <summary>Fails a refused call the way the method fails: a faulted task for an async method, a throw for the rest.</summary>
internal static class TaskFault
{
    /// <summary>Whether a method with this return type is awaited (<see cref="Task"/> or <see cref="Task{TResult}"/>).</summary>
    internal static bool IsTask(Type returnType) =>
        returnType == typeof(Task) || returnType.IsGenericType && returnType.GetGenericTypeDefinition() == typeof(Task<>);

    /// <summary>
    /// A faulted task of <paramref name="returnType"/> holding <paramref name="error"/>, or <see langword="null"/> when the
    /// method is synchronous and the caller should throw instead.
    /// </summary>
    internal static object? Create(Type returnType, Exception error)
    {
        if (returnType == typeof(Task))
        {
            return Task.FromException(error);
        }

        return IsTask(returnType)
            ? typeof(Task).GetMethod(nameof(Task.FromException), 1, [typeof(Exception)])!
                .MakeGenericMethod(returnType.GetGenericArguments()[0]).Invoke(null, [error])
            : null;
    }
}
