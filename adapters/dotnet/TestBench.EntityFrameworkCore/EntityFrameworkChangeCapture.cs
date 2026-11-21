using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.ChangeTracking;
using TestBench.AspNetCore;

namespace TestBench.EntityFrameworkCore;

internal sealed class EntityFrameworkChangeCapture : IPreviewObservation
{
    private readonly DbContext _context;
    private readonly List<PreviewChange> _changes = [];
    private readonly List<PendingChange> _pending = [];
    private bool _pendingTruncated;

    public EntityFrameworkChangeCapture(DbContext context)
    {
        _context = context;
        _context.SavingChanges += OnSavingChanges;
        _context.SavedChanges += OnSavedChanges;
        _context.SaveChangesFailed += OnSaveChangesFailed;
    }

    public IReadOnlyList<PreviewChange> Changes => _changes;

    public bool ChangesTruncated { get; private set; }

    public void Dispose()
    {
        _context.SavingChanges -= OnSavingChanges;
        _context.SavedChanges -= OnSavedChanges;
        _context.SaveChangesFailed -= OnSaveChangesFailed;
    }

    private void OnSavingChanges(object? sender, SavingChangesEventArgs args)
    {
        // SavingChanges fires before EF's automatic DetectChanges.
        _context.ChangeTracker.DetectChanges();
        _pending.Clear();
        var remaining = CaptureLimits.Changes - _changes.Count;
        foreach (var entry in _context.ChangeTracker.Entries()
            .Where(entry => entry.State is EntityState.Added or EntityState.Modified or EntityState.Deleted))
        {
            if (_pending.Count == remaining)
            {
                _pendingTruncated = true;
                break;
            }

            _pending.Add(PendingChange.Create(entry, this));
        }
    }

    private void OnSavedChanges(object? sender, SavedChangesEventArgs args)
    {
        foreach (var pending in _pending)
        {
            _changes.Add(pending.Complete(this));
        }

        ChangesTruncated |= _pendingTruncated;
        ClearPending();
    }

    private void OnSaveChangesFailed(object? sender, SaveChangesFailedEventArgs args) => ClearPending();

    private void ClearPending()
    {
        _pendingTruncated = false;
        _pending.Clear();
    }

    private sealed record PendingChange(EntityEntry Entry, EntityState State, string Table,
        Dictionary<string, object?>? Before)
    {
        public static PendingChange Create(EntityEntry entry, EntityFrameworkChangeCapture capture)
        {
            var table = entry.Metadata.GetTableName() ?? entry.Metadata.DisplayName();
            var schema = entry.Metadata.GetSchema();
            if (schema is not null) table = $"{schema}.{table}";
            return new(entry, entry.State, table,
                entry.State == EntityState.Added ? null : capture.Values(entry, original: true));
        }

        public PreviewChange Complete(EntityFrameworkChangeCapture capture)
        {
            var key = Entry.Metadata.FindPrimaryKey()?.Properties.ToDictionary(
                property => property.Name, property => capture.Snapshot(Entry.Property(property.Name).CurrentValue));
            return new PreviewChange(State switch
            {
                EntityState.Added => "insert",
                EntityState.Modified => "update",
                _ => "delete"
            }, Table, key, Before, State == EntityState.Deleted ? null : capture.Values(Entry, original: false));
        }
    }

    private Dictionary<string, object?> Values(EntityEntry entry, bool original)
    {
        var fields = new Dictionary<string, object?>();
        foreach (var property in entry.Properties)
        {
            if (fields.Count == CaptureLimits.Parameters)
            {
                _pendingTruncated = true;
                break;
            }

            fields[property.Metadata.Name] = Snapshot(original ? property.OriginalValue : property.CurrentValue);
        }

        return fields;
    }

    private object? Snapshot(object? value)
    {
        switch (value)
        {
            case null or ValueType:
                return value;
            case string text:
                var clipped = CaptureLimits.Clip(text);
                _pendingTruncated |= clipped.Length != text.Length;
                return clipped;
            case byte[] bytes:
                var length = Math.Min(bytes.Length, CaptureLimits.Text * 3 / 4);
                _pendingTruncated |= length < bytes.Length;
                return bytes.AsSpan(0, length).ToArray();
            default:
                var snapshot = CaptureLimits.Snapshot(value);
                _pendingTruncated |= snapshot is null;
                return snapshot;
        }
    }
}
