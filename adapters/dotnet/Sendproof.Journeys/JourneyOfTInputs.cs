namespace Sendproof.Journeys;

/// <summary>
/// One journey: an ordered set of operations a person performs to finish a task. Override <see cref="Define"/> and
/// describe the steps on the builder. At startup every registered journey becomes an Arazzo 1.1 workflow and its entry
/// in the expectations document.
/// </summary>
/// <typeparam name="TInputs">
/// A plain class whose properties are the journey's inputs. Property types, defaults and XML comments become the
/// workflow's <c>inputs</c> schema.
/// </typeparam>
public abstract class Journey<TInputs> : Journey where TInputs : class, new()
{
    /// <summary>Describes the journey: its name, inputs, steps and what each step should write.</summary>
    protected abstract void Define(JourneyBuilder<TInputs> journey);

    internal override JourneyModel Describe()
    {
        var builder = new JourneyBuilder<TInputs>(GetType());
        try
        {
            Define(builder);
        }
        catch (Exception exception)
        {
            // Every problem is reported at once, so a definition that throws is one more line in the list.
            builder.Model.Problems.Add(exception is JourneyDefinitionException ? exception.Message
                : $"Define threw {exception.GetType().Name}: {exception.Message}");
        }

        return builder.Model;
    }
}
