namespace Sendproof.Journeys;

/// <summary>An email a step should hold or send: who it goes to and its subject.</summary>
public sealed class EmailExpectation
{
    private readonly StepWrites _writes;
    private readonly ExpectedEffect _effect;

    internal EmailExpectation(StepWrites writes, ExpectedEffect effect)
    {
        _writes = writes;
        _effect = effect;
    }

    /// <summary>The email goes to this address.</summary>
    public EmailExpectation To(string address) => Put("to", JourneyValue.Literal(address, typeof(string)));

    /// <summary>The email goes to an input or an earlier output, such as the customer's email.</summary>
    public EmailExpectation To(Ref<string> address) => Put("to", JourneyValue.Reference(address.Source));

    /// <summary>The email has this subject.</summary>
    public EmailExpectation Subject(string subject) => Put("subject", JourneyValue.Literal(subject, typeof(string)));

    /// <summary>The email's subject matches, such as <c>Match.Pattern("shipped")</c>.</summary>
    public EmailExpectation Subject(Matcher<string> subject) => Put("subject", subject.Value);

    private EmailExpectation Put(string key, JourneyValue value)
    {
        _writes.Check(value, $"the email's {key}");
        _effect.Data[key] = value;
        return this;
    }
}
