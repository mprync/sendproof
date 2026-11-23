using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;

namespace Sendproof.Journeys.Generators;

/// <summary>
/// An immutable array compared by its items, so the incremental pipeline can tell an unchanged endpoint from a changed
/// one and skip regenerating.
/// </summary>
internal readonly struct EquatableArray<T>(T[] items) : IEquatable<EquatableArray<T>>, IEnumerable<T> where T : IEquatable<T>
{
    private readonly T[]? _items = items;

    public int Count => _items?.Length ?? 0;

    public bool Equals(EquatableArray<T> other) => (_items ?? []).AsSpan().SequenceEqual(other._items ?? []);

    public override bool Equals(object? obj) => obj is EquatableArray<T> other && Equals(other);

    public override int GetHashCode() => (_items ?? []).Aggregate(17, (hash, item) => hash * 31 + item.GetHashCode());

    public IEnumerator<T> GetEnumerator() => ((IEnumerable<T>)(_items ?? [])).GetEnumerator();

    IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
}
