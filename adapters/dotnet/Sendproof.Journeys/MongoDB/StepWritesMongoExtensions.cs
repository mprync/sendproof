namespace Sendproof.Journeys.MongoDB;

/// <summary>Adds the MongoDB entry point to <see cref="StepWrites"/>.</summary>
public static class StepWritesMongoExtensions
{
    /// <summary>The documents the step should write to MongoDB.</summary>
    public static MongoWrites Mongo(this StepWrites writes)
    {
        ArgumentNullException.ThrowIfNull(writes);
        return new MongoWrites(writes);
    }
}
