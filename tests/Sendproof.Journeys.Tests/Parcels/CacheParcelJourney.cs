namespace Sendproof.Journeys.Tests;

/// <summary>A journey whose step expects a Redis write, so it is Send only.</summary>
public sealed class CacheParcelJourney : Journey<ParcelInputs>
{
    protected override void Define(JourneyBuilder<ParcelInputs> journey)
    {
        journey.Name("Cache a parcel");
        var register = journey.Step("register", ParcelOperations.Parcels.Register);
        register.Set(r => r.Body.Label, journey.Input(i => i.Label));
        register.SucceedsWith(201);
        Ref<Guid> parcelId = register.Output(parcel => parcel.Id, "parcelId");
        register.ExpectWrites(writes => writes.Redis("cache")
            .Command(RedisCommand.Set, RedisKey.Format("parcel:{0}", parcelId), expiry: Match.Any<TimeSpan>()));
    }
}
