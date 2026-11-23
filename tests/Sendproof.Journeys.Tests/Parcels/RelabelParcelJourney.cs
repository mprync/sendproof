using Sendproof.Journeys.EntityFrameworkCore;
using Sendproof.Journeys.MongoDB;

namespace Sendproof.Journeys.Tests;

/// <summary>Registers a parcel and relabels it: two write steps, an approved difference and a MongoDB expectation.</summary>
public sealed class RelabelParcelJourney : Journey<ParcelInputs>
{
    protected override void Define(JourneyBuilder<ParcelInputs> journey)
    {
        journey.Name("Relabel a parcel");
        journey.Group("Parcels");

        Ref<string> label = journey.Input(i => i.Label);
        Ref<string> newLabel = journey.Input(i => i.NewLabel);

        var register = journey.Step("register", ParcelOperations.Parcels.Register);
        register.Set(r => r.Body.Label, label);
        register.Set(r => r.Body.NotifyOwner, true);
        register.SucceedsWith(201);
        Ref<Guid> parcelId = register.Output(parcel => parcel.Id, "parcelId");
        register.ExpectWrites(writes =>
        {
            writes.Sql<ParcelDbContext>().Insert(db => db.Parcels)
                .Set(p => p.Id, parcelId)
                .Set(p => p.Label, label)
                .Set(p => p.Status, "Registered")
                .Set(p => p.CreatedAt, Match.Any<DateTimeOffset>());
            writes.Mongo().Insert<ParcelEventDocument>()
                .Set(e => e.ParcelId, parcelId)
                .Set(e => e.Kind, "parcel.registered");
            writes.Email().To("owner@example.test").Subject(Match.Pattern("registered$"));
        });

        var relabel = journey.Step("relabel", ParcelOperations.Parcels.Relabel);
        relabel.Set(r => r.Id, parcelId);
        relabel.Set(r => r.Body.Label, newLabel);
        relabel.SucceedsWith(200);
        relabel.ExpectResponse(parcel => parcel.Label, "Red box");
        relabel.ExpectWrites(writes => writes.Sql<ParcelDbContext>().Update(db => db.Parcels)
            .Where(p => p.Id, parcelId)
            .Set(p => p.Label, Match.Changed("Blue box", "Red box"))
            .Set(p => p.Status, "Relabeled", ParcelApprovedDifferences.BritishSpelling));
    }
}
