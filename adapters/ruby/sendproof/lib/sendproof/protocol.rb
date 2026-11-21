# frozen_string_literal: true

require "uri"

module Sendproof
  # Wire-level helpers of bench protocol v1.
  module Protocol
    PREFIX = "/sendproof/_preview"
    ROLLBACK_PREFERENCE = "tx=rollback"
    TRACE_HEADER = "x-sendproof-trace"
    JSON_TYPE = "application/json; charset=utf-8"

    # Headers of the inner response that never reach the envelope.
    PRIVATE_HEADERS = %w[set-cookie location content-length transfer-encoding connection upgrade trailer
                         keep-alive proxy-authenticate proxy-authorization te].freeze

    module_function

    # @return [Boolean] whether the request asks for a rollback in any form
    def requests_rollback?(env)
      env["HTTP_PREFER"].to_s.split(/[,;]/).any? do |part|
        name, value = part.split("=", 2).map(&:strip)
        value && name.casecmp?("tx") && value.delete_prefix('"').delete_suffix('"').casecmp?("rollback")
      end
    end

    # The single, exact +Prefer: tx=rollback+ value required by the preview route.
    def exact_preference?(env)
      env["HTTP_PREFER"].to_s.strip.casecmp?(ROLLBACK_PREFERENCE)
    end

    # @return [Boolean] whether +Prefer+ lists the +trace+ token
    def requests_trace?(env)
      env["HTTP_PREFER"].to_s.split(",").any? { |value| value.split(";", 2).first.strip.casecmp?("trace") }
    end

    # Rejects cross-site browsers and any Origin that does not match the request origin.
    def same_origin?(request)
      return false if request.get_header("HTTP_SEC_FETCH_SITE").to_s.casecmp?("cross-site")

      origin = request.get_header("HTTP_ORIGIN")
      return true if origin.nil?
      return false if origin.include?(",")

      uri = URI.parse(origin)
      uri.scheme == request.scheme && uri.host.to_s.casecmp?(request.host) && uri.port == request.port &&
        uri.userinfo.nil? && ["", "/"].include?(uri.path) && uri.query.nil? && uri.fragment.nil?
    rescue URI::InvalidURIError
      false
    end

    # A Rack response carrying an RFC 9457 problem document, never cacheable.
    def problem(status, title, headers = {})
      body = JSON.generate({ type: "about:blank", title:, status: })
      [status, { "content-type" => "application/problem+json", "cache-control" => "no-store",
                 "content-length" => body.bytesize.to_s }.merge(headers), [body]]
    end

    def json(status, document, headers = {})
      body = JSON.generate(document)
      [status, { "content-type" => JSON_TYPE, "content-length" => body.bytesize.to_s }.merge(headers), [body]]
    end

    # Case-insensitive header lookup that tolerates plain hashes with mixed-case keys.
    def header(headers, name)
      key = headers.keys.find { |candidate| candidate.to_s.casecmp?(name) }
      key && headers[key]
    end

    def set_header(headers, name, value)
      key = headers.keys.find { |candidate| candidate.to_s.casecmp?(name) } || name
      headers[key] = value
    end

    # Appends +value+ to a comma-separated header.
    def append_header(headers, name, value)
      existing = header(headers, name)
      set_header(headers, name, existing.nil? || existing.to_s.empty? ? value : "#{Array(existing).join(', ')}, #{value}")
    end
  end
end
