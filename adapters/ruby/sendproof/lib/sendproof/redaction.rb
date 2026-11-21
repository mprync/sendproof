# frozen_string_literal: true

module Sendproof
  # Decides whether SQL text or a parameter name refers to a secret.
  #
  # Matching uses whole words, so +IdempotencyKey+ or +monkey+ stay visible while
  # +password_hash+, +api_key+ and +RefreshToken+ are hidden.
  module Redaction
    REDACTED = "[REDACTED]"

    SECRET_WORDS = %w[password passwd pwd secret token hash salt credential credentials apikey].freeze
    # "key" alone is ordinary (primary key, idempotency key); it is secret only after these words.
    KEY_QUALIFIERS = %w[api private secret access signing encryption client].freeze

    module_function

    # @return [Boolean] whether any word in +text+ names a secret
    def looks_secret?(text)
      previous = nil
      words(text.to_s).any? do |word|
        secret = SECRET_WORDS.include?(word) || (word == "key" && KEY_QUALIFIERS.include?(previous))
        previous = word
        secret
      end
    end

    # Replaces the value of every secret-named field with {REDACTED}, at any depth of a nested
    # document or array. A secret-named field hides its whole value, nested or not.
    #
    # @return [Object] a copy; scalars come back as given
    def deep(value)
      case value
      when Hash then value.to_h { |name, inner| [name, looks_secret?(name) ? REDACTED : deep(inner)] }
      when Array then value.map { |item| deep(item) }
      else value
      end
    end

    # Splits at punctuation, underscores, digits-to-letters and camelCase boundaries; lowercases.
    def words(text)
      text.scan(/[[:alnum:]]+/).flat_map do |chunk|
        chunk.gsub(/(?<=[[:lower:]])(?=[[:upper:]])/, " ").split
      end.map(&:downcase)
    end
  end
end
