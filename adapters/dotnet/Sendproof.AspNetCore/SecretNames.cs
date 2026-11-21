using System.Text.Json.Nodes;

namespace Sendproof.AspNetCore;

/// <summary>
/// The whole-word rule for secret-looking names (spec/data-stores.md "Secret fields"), shared by SQL parameters,
/// EF Core change snapshots and the nested documents of data stores.
/// </summary>
internal static class SecretNames
{
    /// <summary>The value shown in place of a secret.</summary>
    internal const string Redacted = "[REDACTED]";

    // Matched against whole words, so IdempotencyKey or Monkey stay visible while
    // PasswordHash, api_key and RefreshToken are hidden.
    private static readonly HashSet<string> SecretWords = new(StringComparer.OrdinalIgnoreCase)
    {
        "password", "passwd", "pwd", "secret", "token", "hash", "salt", "credential", "credentials", "apikey"
    };

    // "Key" alone is ordinary (primary key, idempotency key); it is secret only after these words.
    private static readonly HashSet<string> SecretKeyQualifiers = new(StringComparer.OrdinalIgnoreCase)
    {
        "api", "private", "secret", "access", "signing", "encryption", "client"
    };

    /// <summary>Whether an identifier or statement names a secret, judged by whole words.</summary>
    internal static bool LooksSecret(string text)
    {
        string? previous = null;
        foreach (var word in Words(text))
        {
            if (SecretWords.Contains(word) ||
                word.Equals("key", StringComparison.OrdinalIgnoreCase) && previous is not null && SecretKeyQualifiers.Contains(previous))
            {
                return true;
            }

            previous = word;
        }

        return false;
    }

    /// <summary>
    /// Replaces the value of every secret-named field with <see cref="Redacted"/>, at any depth of a nested
    /// document, editing the node in place and returning it. Array items are visited; a field is judged by its own
    /// name only.
    /// </summary>
    internal static JsonNode? RedactDeep(JsonNode? node)
    {
        switch (node)
        {
            case JsonObject document:
                foreach (var name in document.Select(pair => pair.Key).ToArray())
                {
                    if (LooksSecret(name))
                    {
                        document[name] = JsonValue.Create(Redacted);
                    }
                    else
                    {
                        RedactDeep(document[name]);
                    }
                }

                break;
            case JsonArray array:
                foreach (var item in array)
                {
                    RedactDeep(item);
                }

                break;
        }

        return node;
    }

    /// <summary>Splits identifiers and SQL text into words at punctuation, underscores and camel-case boundaries.</summary>
    private static IEnumerable<string> Words(string text)
    {
        var start = -1;
        for (var i = 0; i <= text.Length; i++)
        {
            var letterOrDigit = i < text.Length && char.IsLetterOrDigit(text[i]);
            var boundary = !letterOrDigit || start >= 0 && char.IsUpper(text[i]) && char.IsLower(text[i - 1]);
            if (boundary && start >= 0)
            {
                yield return text[start..i];
                start = -1;
            }

            if (letterOrDigit && start < 0)
            {
                start = i;
            }
        }
    }
}
