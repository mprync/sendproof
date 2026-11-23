using Microsoft.EntityFrameworkCore;
using Sendproof.Journeys.EntityFrameworkCore;

namespace Sendproof.Journeys.Tests;

/// <summary>A journey with every mistake the startup check catches: an output read before its step, two steps with one ID, a type the model doesn't have.</summary>
public sealed class WrongJourney : Journey<ParcelInputs>
{
    protected override void Define(JourneyBuilder<ParcelInputs> journey)
    {
        var relabel = journey.Step("relabel", ParcelOperations.Parcels.Relabel);
        var read = journey.Step("read", ParcelOperations.Parcels.Get);
        relabel.Set(r => r.Id, read.Output(parcel => parcel.Id));
        journey.Step("read", ParcelOperations.Parcels.Get);
        relabel.ExpectWrites(writes => writes.Sql<ParcelDbContext>().Insert(db => db.Set<UnmappedRow>()));
    }
}

/// <summary>A class the parcel model doesn't map.</summary>
public sealed class UnmappedRow
{
    public int Id { get; set; }
}
