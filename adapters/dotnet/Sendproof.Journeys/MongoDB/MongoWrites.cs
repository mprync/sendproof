namespace Sendproof.Journeys.MongoDB;

/// <summary>
/// The documents a step should write to MongoDB. Each document class's field names come from its BSON class map, and
/// its collection from <c>JourneyOptions.MapCollection&lt;TDocument&gt;</c>.
/// </summary>
public sealed class MongoWrites
{
    private readonly StepWrites _writes;

    internal MongoWrites(StepWrites writes) => _writes = writes;

    /// <summary>The step inserts a document of this class.</summary>
    public WriteExpectation<TDocument> Insert<TDocument>() => Add<TDocument>("insert");

    /// <summary>The step updates a document of this class, found by its <c>Where</c> key.</summary>
    public WriteExpectation<TDocument> Update<TDocument>() => Add<TDocument>("update");

    /// <summary>The step deletes a document of this class, found by its <c>Where</c> key.</summary>
    public WriteExpectation<TDocument> Delete<TDocument>() => Add<TDocument>("delete");

    private WriteExpectation<TDocument> Add<TDocument>(string operation)
    {
        var write = new FieldWrite(new MongoTarget(typeof(TDocument)), operation);
        _writes.Add(write);
        return new WriteExpectation<TDocument>(_writes, write);
    }
}
