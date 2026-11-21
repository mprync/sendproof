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

    # Replaces the literals in SQL text with +?+: single-quoted strings (with +''+ and backslash escapes),
    # hexadecimal and numeric literals. Quoted identifiers (backticks and double quotes) and names with
    # digits in them are kept. A database that doesn't use prepared statements (MySQL through Trilogy or
    # mysql2) inlines parameter values into the statement text, so hiding values means masking them here too.
    #
    # @return [String]
    def mask_literals(sql)
      text = sql.to_s
      output = +""
      index = 0
      while index < text.length
        char = text[index]
        if char == "'" || (char.match?(/[xX]/) && text[index + 1] == "'" && !word_before?(text, index))
          stop = closing_quote(text, index + (char == "'" ? 0 : 1))
          output << "?"
          index = stop
        elsif char == "`" || char == '"'
          close = text.index(char, index + 1)
          stop = close ? close + 1 : text.length
          output << text[index...stop]
          index = stop
        elsif char.match?(/[0-9]/) && !word_before?(text, index)
          number = text[index..][/\A(?:0[xX]\h+|[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/]
          output << "?"
          index += number.length
        else
          output << char
          index += 1
        end
      end
      output
    end

    # @return [Integer] the index after the single-quoted string that starts at +start+
    def closing_quote(text, start)
      index = start + 1
      while index < text.length
        if text[index] == "\\"
          index += 2
        elsif text[index] == "'" && text[index + 1] == "'"
          index += 2
        elsif text[index] == "'"
          return index + 1
        else
          index += 1
        end
      end
      text.length
    end

    def word_before?(text, index) = index.positive? && text[index - 1].match?(/[[:alnum:]_$.@]/)

    # Splits at punctuation, underscores, digits-to-letters and camelCase boundaries; lowercases.
    def words(text)
      text.scan(/[[:alnum:]]+/).flat_map do |chunk|
        chunk.gsub(/(?<=[[:lower:]])(?=[[:upper:]])/, " ").split
      end.map(&:downcase)
    end
  end
end
