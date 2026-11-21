using System.Collections.Concurrent;
using System.Xml.Linq;
using Microsoft.AspNetCore.DataProtection.Repositories;

namespace TestBench.AspNetCore.Tests;

/// <summary>Keeps each test host's ASP.NET Core data protection keys isolated in memory.</summary>
internal sealed class InMemoryKeyRepository : IXmlRepository
{
    private readonly ConcurrentBag<XElement> _keys = [];

    public IReadOnlyCollection<XElement> GetAllElements() => _keys.ToArray();
    public void StoreElement(XElement element, string friendlyName) => _keys.Add(new XElement(element));
}
