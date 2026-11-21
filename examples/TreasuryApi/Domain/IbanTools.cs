using System.Numerics;

namespace TreasuryApi;

/// <summary>Formats and validates IBANs and ABA routing numbers, and computes IBAN check digits.</summary>
internal static class IbanTools
{
    /// <summary>The IBAN length of each country the demo knows. IBANs of other countries are checked by checksum only.</summary>
    private static readonly Dictionary<string, int> Lengths = new()
    {
        ["AT"] = 20, ["BE"] = 16, ["CH"] = 21, ["DE"] = 22, ["DK"] = 18, ["ES"] = 24, ["FR"] = 27, ["GB"] = 22,
        ["IE"] = 22, ["IT"] = 27, ["LU"] = 20, ["NL"] = 18, ["NO"] = 15, ["PL"] = 28, ["SE"] = 24
    };

    /// <summary>Upper-cases an IBAN and removes spaces.</summary>
    internal static string Compact(string iban) => new(iban.Where(c => !char.IsWhiteSpace(c)).Select(char.ToUpperInvariant).ToArray());

    /// <summary>Returns an IBAN in its printed form: groups of four characters separated by spaces.</summary>
    internal static string Format(string iban)
    {
        var compact = Compact(iban);
        return string.Join(' ', Enumerable.Range(0, (compact.Length + 3) / 4).Select(i => compact.Substring(i * 4, Math.Min(4, compact.Length - i * 4))));
    }

    /// <summary>Whether the IBAN has a plausible length and valid ISO 7064 mod 97-10 check digits.</summary>
    internal static bool IsValid(string iban)
    {
        var compact = Compact(iban);
        if (compact.Length < 15 || compact.Length > 34 || !compact.All(char.IsAsciiLetterOrDigit)) return false;
        if (Lengths.TryGetValue(compact[..2], out var length) && length != compact.Length) return false;
        return Mod97(compact[4..] + compact[..4]) == 1;
    }

    /// <summary>Builds a complete, valid IBAN from a country code and a BBAN by computing the check digits.</summary>
    internal static string Build(string country, string bban)
    {
        var check = 98 - Mod97(bban + country + "00");
        return $"{country}{check:00}{bban}";
    }

    /// <summary>Whether a nine-digit ABA routing number passes the 3-7-1 weighted checksum.</summary>
    internal static bool IsValidAbaRouting(string routing)
    {
        if (routing.Length != 9 || !routing.All(char.IsAsciiDigit)) return false;
        int[] weights = [3, 7, 1, 3, 7, 1, 3, 7, 1];
        return routing.Select((c, i) => (c - '0') * weights[i]).Sum() % 10 == 0;
    }

    /// <summary>Completes an eight-digit prefix to a routing number that passes the ABA checksum.</summary>
    internal static string BuildAbaRouting(string firstEight)
    {
        int[] weights = [3, 7, 1, 3, 7, 1, 3, 7];
        var sum = firstEight.Select((c, i) => (c - '0') * weights[i]).Sum();
        return firstEight + ((10 - sum % 10) % 10);
    }

    private static int Mod97(string text)
    {
        var digits = string.Concat(text.Select(c => char.IsAsciiLetter(c) ? (char.ToUpperInvariant(c) - 'A' + 10).ToString() : c.ToString()));
        return (int)(BigInteger.Parse(digits) % 97);
    }
}
