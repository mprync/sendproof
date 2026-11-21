# frozen_string_literal: true

require "base64"
require "bigdecimal"

module Sendproof
  module Mongo
    # Converts BSON values to plain JSON data, using MongoDB Extended JSON v2 relaxed form for the types
    # JSON lacks (+{"$oid": ...}+, +{"$date": ...}+), so a change record is the document as stored.
    module Plain
      module_function

      # @return [Object] +nil+, booleans, numbers, strings, arrays and string-keyed hashes
      def call(value)
        case value
        when nil, true, false, Integer, String then value
        when Float then value.finite? ? value : value.to_s
        when Symbol then value.to_s
        when Array then value.map { |item| call(item) }
        when Hash then value.to_h { |name, inner| [name.to_s, call(inner)] }
        when Time then { "$date" => value.utc.iso8601(3) }
        when ::BSON::ObjectId then { "$oid" => value.to_s }
        when ::BSON::Decimal128 then { "$numberDecimal" => value.to_s }
        when BigDecimal then { "$numberDecimal" => value.to_s("F") }
        when ::BSON::Timestamp then { "$timestamp" => { "t" => value.seconds, "i" => value.increment } }
        when ::BSON::Binary then { "$binary" => { "base64" => Base64.strict_encode64(value.data), "subType" => value.type == :generic ? "00" : binary_subtype(value) } }
        when ::BSON::Regexp::Raw then { "$regularExpression" => { "pattern" => value.pattern, "options" => value.options } }
        when Regexp then { "$regularExpression" => { "pattern" => value.source, "options" => regexp_options(value) } }
        when ::BSON::MinKey then { "$minKey" => 1 }
        when ::BSON::MaxKey then { "$maxKey" => 1 }
        when ::BSON::Code then value.code
        else value.respond_to?(:as_json) ? call(value.as_json) : value.to_s
        end
      end

      def binary_subtype(binary)
        { function: "01", old: "02", uuid_old: "03", uuid: "04", md5: "05", ciphertext: "06", column: "07", sensitive: "08" }.fetch(binary.type, "00")
      end

      def regexp_options(regexp)
        "#{'i' if regexp.options & Regexp::IGNORECASE != 0}#{'m' if regexp.options & Regexp::MULTILINE != 0}"
      end
    end
  end
end
