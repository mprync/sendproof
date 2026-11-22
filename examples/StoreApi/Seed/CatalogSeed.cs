namespace StoreApi;

/// <summary>The seeded catalogue.</summary>
/// <param name="Categories">Every category.</param>
/// <param name="Products">Every product.</param>
/// <param name="Variants">Every variant.</param>
/// <param name="Prices">The price of every variant in every currency.</param>
internal sealed record Catalogue(IReadOnlyList<CategoryRecord> Categories, IReadOnlyList<ProductRecord> Products,
    IReadOnlyList<VariantRecord> Variants, IReadOnlyList<PriceRecord> Prices);

/// <summary>Seeds categories, products, variants and prices of a fictional outdoor-gear store.</summary>
internal static class CatalogSeed
{
    private sealed record Spec(string Slug, string Name, string Brand, string Category, decimal Usd, string Prefix, string[] Colors, string[] Sizes,
        string Blurb, string Tags, int Grams, ProductStatus Status = ProductStatus.Active);

    private static readonly string[] Apparel = ["S", "M", "L", "XL"];
    private static readonly string[] Shoes = ["40", "42", "44"];
    private static readonly string[] None = [];

    private static readonly Dictionary<string, string> ColorCodes = new()
    {
        ["Black"] = "BLK", ["Forest"] = "FOR", ["Ember"] = "EMB", ["Slate"] = "SLT", ["Moss"] = "MSS", ["Navy"] = "NVY", ["Orange"] = "ORG",
        ["Grey"] = "GRY", ["Blue"] = "BLU", ["Olive"] = "OLV", ["Sand"] = "SND", ["Brown"] = "BRN", ["Green"] = "GRN", ["Red"] = "RED", ["Steel"] = "STL"
    };

    private static readonly (string Slug, string Name, string? Parent, string Description)[] CategoryRows =
    [
        ("clothing", "Clothing", null, "Layers for every season on the trail."),
        ("jackets", "Jackets", "clothing", "Shells, down jackets and mid-layers."),
        ("base-layers", "Base layers", "clothing", "Merino and synthetic layers worn next to the skin."),
        ("trousers", "Trousers", "clothing", "Hiking trousers and waterproof overtrousers."),
        ("footwear", "Footwear", null, "Shoes and boots for trails, summits and approaches."),
        ("trail-running-shoes", "Trail running shoes", "footwear", "Light, grippy shoes for running off-road."),
        ("hiking-boots", "Hiking boots", "footwear", "Supportive boots for long days with a pack."),
        ("camping", "Camping", null, "Shelter, sleep and cook outdoors."),
        ("tents", "Tents", "camping", "Backpacking tents and shelters."),
        ("sleeping-bags", "Sleeping bags", "camping", "Bags and quilts rated from +5 °C to -10 °C."),
        ("stoves-cookware", "Stoves and cookware", "camping", "Compact stoves, pots and fuel."),
        ("packs", "Packs", null, "Backpacks and bags for a day out or a month away."),
        ("daypacks", "Daypacks", "packs", "Packs from 20 to 35 litres."),
        ("travel-bags", "Travel bags", "packs", "Duffels that survive an airport."),
        ("accessories", "Accessories", null, "The small things that make a trip better."),
        ("headwear", "Headwear", "accessories", "Beanies, hats and buffs."),
        ("gloves", "Gloves", "accessories", "Liners, gloves and mitts."),
        ("bottles", "Bottles", "accessories", "Steel bottles and soft flasks."),
        ("electronics", "Electronics", null, "Lights and navigation."),
        ("headlamps", "Headlamps", "electronics", "Hands-free light, from 400 to 900 lumens."),
        ("gps-watches", "GPS watches", "electronics", "Watches that keep their battery for the whole route.")
    ];

    private static readonly Spec[] Specs =
    [
        new("northpeak-storm-shell-jacket", "Northpeak Storm Shell Jacket", "Northpeak", "jackets", 189m, "NPK-JKT", ["Black", "Forest", "Ember"], Apparel, "A fully taped three-layer shell that keeps out a day of Atlantic rain and still packs into its own pocket.", "waterproof,bestseller,shell", 520),
        new("northpeak-alpine-down-jacket", "Northpeak Alpine Down Jacket", "Northpeak", "jackets", 279m, "NPK-DWN", ["Black", "Slate"], Apparel, "800-fill responsibly sourced down in a jacket light enough to carry on every summit day.", "warm,down,new", 610),
        new("alder-oak-wool-overshirt", "Alder & Oak Wool Overshirt", "Alder & Oak", "jackets", 129m, "AAO-OVS", ["Moss", "Navy"], ["S", "M", "L"], "A brushed wool-blend overshirt that works as a mid-layer on the hill and a jacket in town.", "wool,casual", 480),
        new("fjordline-packable-wind-jacket", "Fjordline Packable Wind Jacket", "Fjordline", "jackets", 99m, "FJL-WND", ["Orange", "Navy"], ["S", "M", "L"], "Ninety grams of wind protection that disappears into a pocket.", "ultralight,windproof", 95),
        new("alder-oak-merino-base-layer-top", "Alder & Oak Merino Base Layer Top", "Alder & Oak", "base-layers", 89m, "AAO-MBT", ["Black", "Grey"], Apparel, "Soft 190 gsm merino that stays fresh through a three-day hut-to-hut trip.", "merino,bestseller", 190),
        new("alder-oak-merino-leggings", "Alder & Oak Merino Leggings", "Alder & Oak", "base-layers", 84m, "AAO-MLG", ["Black"], ["S", "M", "L"], "Warm, odour-resistant leggings for cold starts and winter camps.", "merino,warm", 210),
        new("kestrel-trail-tee", "Kestrel Trail Tee", "Kestrel", "base-layers", 39m, "KST-TEE", ["Blue", "Grey", "Olive"], ["S", "M", "L"], "A quick-drying recycled-polyester tee with flat seams that never rub under a pack.", "quick-dry,recycled", 140),
        new("northpeak-trekker-pants", "Northpeak Trekker Pants", "Northpeak", "trousers", 119m, "NPK-TRK", ["Black", "Sand"], ["30", "32", "34"], "Stretch trousers with a water-repellent finish and a gusseted crotch for high steps.", "stretch,durable", 430),
        new("fjordline-rain-pants", "Fjordline Rain Pants", "Fjordline", "trousers", 109m, "FJL-RPT", ["Black"], ["S", "M", "L"], "Full-length side zips let you pull them on over boots in a downpour.", "waterproof,packable", 330),
        new("kestrel-ridgeline-trail-runner", "Kestrel Ridgeline Trail Runner", "Kestrel", "trail-running-shoes", 139m, "KST-RDG", ["Black", "Orange"], Shoes, "A 6 mm drop trail shoe with a lugged outsole and a rock plate for technical ground.", "trail,grippy,bestseller", 590),
        new("kestrel-ultra-trail-shoe", "Kestrel Ultra Trail Shoe", "Kestrel", "trail-running-shoes", 169m, "KST-ULT", ["Blue", "Grey"], ["41", "43", "45"], "Max cushioning for long days, with a wide toe box that lets your feet swell.", "cushioned,ultra", 640),
        new("northpeak-granite-hiking-boot", "Northpeak Granite Hiking Boot", "Northpeak", "hiking-boots", 219m, "NPK-GRB", ["Brown", "Black"], ["40", "42", "44", "46"], "A full-grain leather boot, resolable and waterproof, built for heavy packs.", "leather,waterproof", 1180),
        new("kestrel-approach-shoe", "Kestrel Approach Shoe", "Kestrel", "hiking-boots", 149m, "KST-APR", ["Grey", "Olive"], Shoes, "A sticky-rubber approach shoe for scrambling to the base of the climb.", "scrambling,sticky", 700),
        new("fjordline-cairn-2-tent", "Fjordline Cairn 2 Tent", "Fjordline", "tents", 349m, "FJL-CR2", ["Green", "Orange"], None, "A freestanding two-person tent with two doors and two porches, pitched in four minutes.", "2-person,freestanding", 1900),
        new("fjordline-cairn-3-tent", "Fjordline Cairn 3 Tent", "Fjordline", "tents", 429m, "FJL-CR3", ["Green"], None, "The same pitch as the Cairn 2 with room for a third sleeper or a pile of gear.", "3-person,freestanding", 2350),
        new("fjordline-bivy-shelter", "Fjordline Bivy Shelter", "Fjordline", "tents", 159m, "FJL-BVY", ["Olive"], None, "A one-person waterproof shelter for fast-and-light nights out.", "ultralight,solo", 460),
        new("northpeak-comet-0c-sleeping-bag", "Northpeak Comet 0 °C Sleeping Bag", "Northpeak", "sleeping-bags", 189m, "NPK-CM0", ["Blue", "Red"], ["Regular", "Long"], "A three-season bag with a draft collar and a comfort rating of +3 °C.", "3-season,synthetic", 1050),
        new("northpeak-comet-minus10-sleeping-bag", "Northpeak Comet -10 °C Sleeping Bag", "Northpeak", "sleeping-bags", 279m, "NPK-CM10", ["Slate"], ["Regular", "Long"], "A winter bag filled with hydrophobic down and tested to -10 °C.", "winter,down", 1480),
        new("fjordline-ultralight-quilt", "Fjordline Ultralight Quilt", "Fjordline", "sleeping-bags", 229m, "FJL-QLT", ["Moss"], None, "A 450 g backpacking quilt that straps to your mat so you never roll off it.", "ultralight,quilt", 450),
        new("summit-forge-solo-stove", "Summit Forge Solo Stove", "Summit Forge", "stoves-cookware", 79m, "SMF-SLO", ["Steel"], None, "Boils half a litre in under two minutes and folds to the size of a ketchup sachet.", "stove,compact,bestseller", 85),
        new("summit-forge-titanium-pot-set", "Summit Forge Titanium Pot Set", "Summit Forge", "stoves-cookware", 99m, "SMF-TPS", ["Steel"], None, "A 900 ml pot, a lid that doubles as a plate and a long spork, all in titanium.", "titanium,cookware", 210),
        new("summit-forge-pocket-burner", "Summit Forge Pocket Burner", "Summit Forge", "stoves-cookware", 49m, "SMF-PKT", ["Steel"], None, "A tiny canister burner with a wind-resistant flame ring.", "stove,budget", 70),
        new("summit-forge-gas-canister-230g", "Summit Forge Gas Canister 230 g", "Summit Forge", "stoves-cookware", 9.50m, "SMF-GAS", ["Steel"], None, "A 230 g isobutane-propane canister with a resealable valve.", "fuel,consumable", 380),
        new("northpeak-ridge-22-daypack", "Northpeak Ridge 22 Daypack", "Northpeak", "daypacks", 109m, "NPK-R22", ["Black", "Green", "Blue"], ["S/M", "M/L"], "A ventilated 22-litre pack with a hydration sleeve and a rain cover in the base.", "22l,ventilated,bestseller", 780),
        new("northpeak-ridge-32-pack", "Northpeak Ridge 32 Pack", "Northpeak", "daypacks", 139m, "NPK-R32", ["Black", "Olive"], ["S/M", "M/L"], "Room for an overnight trip: 32 litres, a sleeping-bag compartment and trekking-pole loops.", "32l,overnight", 1020),
        new("alder-oak-commuter-pack", "Alder & Oak Commuter Pack", "Alder & Oak", "daypacks", 129m, "AAO-CMP", ["Black", "Grey"], None, "A waxed-canvas pack with a padded 16-inch laptop sleeve and a hidden passport pocket.", "commute,laptop", 900),
        new("fjordline-expedition-duffel-60l", "Fjordline Expedition Duffel 60 L", "Fjordline", "travel-bags", 149m, "FJL-D60", ["Black", "Orange"], None, "A tarpaulin duffel that carries like a backpack and takes the weather in its stride.", "60l,waterproof", 1350),
        new("fjordline-expedition-duffel-90l", "Fjordline Expedition Duffel 90 L", "Fjordline", "travel-bags", 179m, "FJL-D90", ["Black"], None, "The big one for a month away, with compression straps and a lockable zip.", "90l,waterproof", 1680),
        new("alder-oak-merino-beanie", "Alder & Oak Merino Beanie", "Alder & Oak", "headwear", 35m, "AAO-BNE", ["Black", "Grey", "Moss"], None, "A fine-gauge merino beanie that does not itch.", "merino,warm", 60),
        new("alder-oak-brim-hat", "Alder & Oak Brim Hat", "Alder & Oak", "headwear", 45m, "AAO-HAT", ["Sand", "Olive"], ["S/M", "L/XL"], "A wide-brim sun hat with a chin cord and a UPF 50 rating.", "sun,upf50", 90),
        new("northpeak-trail-gloves", "Northpeak Trail Gloves", "Northpeak", "gloves", 49m, "NPK-GLV", ["Black"], ["S", "M", "L"], "Windproof softshell gloves with touchscreen fingertips.", "windproof,touchscreen", 110),
        new("northpeak-insulated-mitts", "Northpeak Insulated Mitts", "Northpeak", "gloves", 69m, "NPK-MIT", ["Black", "Red"], ["S", "M", "L"], "Waterproof mitts with a removable fleece liner for the coldest days.", "waterproof,winter", 190),
        new("summit-forge-steel-bottle-750ml", "Summit Forge Steel Bottle 750 ml", "Summit Forge", "bottles", 29m, "SMF-B75", ["Steel", "Black"], None, "A single-wall stainless bottle you can put straight on the stove.", "steel,bpa-free", 230),
        new("summit-forge-insulated-bottle-1l", "Summit Forge Insulated Bottle 1 L", "Summit Forge", "bottles", 39m, "SMF-I1L", ["Steel", "Black"], None, "Keeps drinks cold for 24 hours or hot for 12.", "insulated,bpa-free", 450),
        new("fjordline-soft-flask-500ml", "Fjordline Soft Flask 500 ml", "Fjordline", "bottles", 24m, "FJL-F50", ["Blue", "Orange"], None, "A collapsible flask that rolls up when it is empty.", "packable,running", 40),
        new("lumen-trail-headlamp-400", "Lumen Trail Headlamp 400", "Lumen", "headlamps", 49m, "LMN-H40", ["Black", "Orange"], None, "400 lumens, a red night mode and a battery that lasts a long weekend.", "400-lumens,usb-c", 85),
        new("lumen-peak-headlamp-900", "Lumen Peak Headlamp 900", "Lumen", "headlamps", 89m, "LMN-H90", ["Black"], None, "A 900-lumen beam with a reactive mode that adjusts to what you look at.", "900-lumens,reactive", 120),
        new("lumen-rechargeable-lantern", "Lumen Rechargeable Lantern", "Lumen", "headlamps", 59m, "LMN-LNT", ["Black"], None, "A tent lantern with a dimmer and a power bank for your phone.", "lantern,power-bank", 280),
        new("lumen-trailtrack-gps-watch", "Lumen TrailTrack GPS Watch", "Lumen", "gps-watches", 299m, "LMN-GPS", ["Black", "Slate"], None, "Multi-band GPS, offline maps and 21 days of battery in smartwatch mode.", "gps,offline-maps,new", 52),
        new("lumen-trailtrack-lite", "Lumen TrailTrack Lite", "Lumen", "gps-watches", 199m, "LMN-LIT", ["Black", "Blue"], None, "The essentials of the TrailTrack: breadcrumb navigation, heart rate and a barometer.", "gps,budget", 44),
        new("alder-oak-wool-socks-3-pack", "Alder & Oak Wool Socks 3-Pack", "Alder & Oak", "base-layers", 32m, "AAO-SOC", ["Grey", "Navy"], ["S", "M", "L"], "Three pairs of cushioned merino socks with a reinforced heel.", "merino,socks", 240),
        new("summit-forge-trekking-poles", "Summit Forge Trekking Poles", "Summit Forge", "accessories", 89m, "SMF-POL", ["Black"], None, "A pair of carbon poles with cork grips that fold to 38 cm.", "carbon,folding", 420),
        new("northpeak-aurora-parka", "Northpeak Aurora Parka", "Northpeak", "jackets", 349m, "NPK-AUR", ["Black"], Apparel, "Coming this winter: a long insulated parka with a fur-free hood.", "winter,coming-soon", 1250, ProductStatus.Draft),
        new("kestrel-ridgeline-trail-runner-v1", "Kestrel Ridgeline Trail Runner (previous model)", "Kestrel", "trail-running-shoes", 119m, "KST-RD1", ["Black"], Shoes, "Replaced by the current Ridgeline; kept here for returns and warranty.", "trail,archived", 610, ProductStatus.Archived)
    ];

    /// <summary>Creates the whole catalogue with prices in every currency.</summary>
    internal static Catalogue Create(Random rng, DateTimeOffset now)
    {
        var categories = new List<CategoryRecord>();
        var bySlug = new Dictionary<string, CategoryRecord>();
        foreach (var (slug, name, parent, description) in CategoryRows)
        {
            var category = new CategoryRecord
            {
                Id = slug == "jackets" ? Guid.Parse(DemoData.JacketsCategoryId) : rng.NextGuid(), Slug = slug, Name = name,
                Description = description, ParentId = parent is null ? null : bySlug[parent].Id
            };
            categories.Add(category);
            bySlug[slug] = category;
        }

        var products = new List<ProductRecord>();
        var variants = new List<VariantRecord>();
        var prices = new List<PriceRecord>();
        foreach (var (spec, index) in Specs.Select((s, i) => (s, i)))
        {
            var created = now.AddDays(-rng.Between(20, 560)).AddHours(-rng.Between(0, 23));
            var product = new ProductRecord
            {
                Id = spec.Slug == "northpeak-storm-shell-jacket" ? Guid.Parse(DemoData.JacketId) : rng.NextGuid(), Slug = spec.Slug, Name = spec.Name, Brand = spec.Brand,
                Description = Describe(spec), CategoryId = bySlug[spec.Category].Id, Status = spec.Status, Tags = spec.Tags, WeightGrams = spec.Grams,
                WidthCm = rng.Between(10, 45), HeightCm = rng.Between(5, 60), DepthCm = rng.Between(4, 30),
                CreatedAt = created, UpdatedAt = created.AddDays(rng.Between(0, 15))
            };
            var (rating, count) = ReviewSeed.Summary(spec.Slug);
            product.RatingAverage = spec.Status == ProductStatus.Draft ? 0 : rating;
            product.ReviewCount = spec.Status == ProductStatus.Draft ? 0 : count;
            products.Add(product);

            var sizes = spec.Sizes.Length == 0 ? new string?[] { null } : spec.Sizes.Cast<string?>().ToArray();
            foreach (var color in spec.Colors)
                foreach (var size in sizes)
                {
                    var code = ColorCodes.GetValueOrDefault(color, color[..3].ToUpperInvariant());
                    var sku = size is null ? (spec.Colors.Length == 1 ? spec.Prefix : $"{spec.Prefix}-{code}") : spec.Colors.Length == 1 ? $"{spec.Prefix}-{Compact(size)}" : $"{spec.Prefix}-{code}-{Compact(size)}";
                    var variant = new VariantRecord
                    {
                        Id = rng.NextGuid(), ProductId = product.Id, Sku = sku, Color = spec.Colors.Length == 1 && color == "Steel" ? null : color, Size = size,
                        Name = string.Join(" / ", new[] { spec.Colors.Length == 1 && color == "Steel" ? null : color, size }.Where(x => !string.IsNullOrEmpty(x)).DefaultIfEmpty("Standard")),
                        Barcode = "5391" + rng.Digits(9)
                    };
                    variants.Add(variant);
                    var longSurcharge = size == "Long" ? 10m : 0m;
                    foreach (var currency in Enum.GetValues<Currency>())
                        prices.Add(new PriceRecord { Id = rng.NextGuid(), VariantId = variant.Id, Currency = currency, Amount = Pricing.Convert(spec.Usd + longSurcharge, currency) });
                }
        }
        return new Catalogue(categories, products, variants, prices);
    }

    private static string Compact(string size) => size.Replace("/", "").Replace(" ", "").ToUpperInvariant() switch { "REGULAR" => "REG", var s => s };

    private static string Describe(Spec spec) =>
        $"{spec.Blurb}\n\n**Highlights**\n\n" + string.Join('\n', spec.Tags.Split(',').Select(tag => $"- {char.ToUpperInvariant(tag[0])}{tag[1..].Replace('-', ' ')}")) +
        $"\n\n**Specifications**\n\n- Brand: {spec.Brand}\n- Weight: {spec.Grams} g\n- Colours: {string.Join(", ", spec.Colors)}\n\nFree returns within 30 days.";
}
