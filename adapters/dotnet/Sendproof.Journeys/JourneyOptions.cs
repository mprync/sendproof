namespace Sendproof.Journeys;

/// <summary>Configures the document the journeys defined in code are published in.</summary>
public sealed class JourneyOptions
{
    private string _name = "Journeys";
    private string _fileName = "journeys";

    /// <summary>Gets or sets the name the workbench shows for the document, such as "Store journeys".</summary>
    public string Name
    {
        get => _name;
        set
        {
            ArgumentException.ThrowIfNullOrWhiteSpace(value);
            _name = value;
        }
    }

    /// <summary>
    /// Gets or sets the file name the documents are served under: <c>store</c> serves
    /// <c>/sendproof/journeys/store.arazzo.json</c> and <c>/sendproof/journeys/store.expect.json</c>.
    /// </summary>
    public string FileName
    {
        get => _fileName;
        set
        {
            ArgumentException.ThrowIfNullOrWhiteSpace(value);
            if (value.Any(character => !char.IsAsciiLetterOrDigit(character) && character is not '-' and not '_'))
            {
                throw new ArgumentException("Use letters, digits, - and _ only.", nameof(value));
            }

            _fileName = value;
        }
    }

    internal Dictionary<Type, string> Collections { get; } = [];
    internal List<(string Store, string Table)> Ignored { get; } = [];

    /// <summary>Names the MongoDB collection documents of <typeparamref name="TDocument"/> are stored in.</summary>
    public JourneyOptions MapCollection<TDocument>(string collection)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(collection);
        Collections[typeof(TDocument)] = collection;
        return this;
    }

    /// <summary>
    /// Leaves a table that changes on every request, such as migration history, out of every comparison. An approved
    /// difference can't do this; the API's author declares and reviews it here.
    /// </summary>
    /// <param name="store">The store id, such as <c>sqlite</c>.</param>
    /// <param name="table">The table or collection.</param>
    public JourneyOptions Ignore(string store, string table)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(store);
        ArgumentException.ThrowIfNullOrWhiteSpace(table);
        Ignored.Add((store, table));
        return this;
    }
}
