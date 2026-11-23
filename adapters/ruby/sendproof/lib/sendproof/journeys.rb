# frozen_string_literal: true

module Sendproof
  # Explicitly registered file pairs, separate from the workbench's asset directory.
  class Journeys
    ROUTE = %r{\A/sendproof/journeys/([a-zA-Z0-9._-]+)\.(arazzo|expect)\.json\z}
    Entry = Data.define(:name, :arazzo, :expectations)

    def initialize
      @entries = {}
    end

    def register(path, name: nil)
      path = File.expand_path(path)
      slug = File.basename(path).delete_suffix(".arazzo.json")
      unless path.end_with?(".arazzo.json") && slug.match?(/\A[a-zA-Z0-9][a-zA-Z0-9._-]*\z/)
        raise ConfigurationError, "Register a journey named <name>.arazzo.json."
      end
      expected = File.join(File.dirname(path), "#{slug}.expect.json")
      arazzo = JSON.parse(File.read(path))
      expectations = JSON.parse(File.read(expected))
      unless arazzo.is_a?(Hash) && expectations.is_a?(Hash)
        raise ConfigurationError, "Journey files must contain JSON objects."
      end

      title = name || arazzo.dig("info", "title") || slug
      @entries[slug] = Entry.new(title, arazzo, expectations)
    rescue SystemCallError, JSON::ParserError => error
      raise ConfigurationError, "Could not load the journey pair: #{error.message}"
    end

    def discovery(base)
      @entries.map do |slug, entry|
        url = "#{base}/sendproof/journeys/#{slug}"
        { name: entry.name, source: "file", arazzoUrl: "#{url}.arazzo.json", expectationsUrl: "#{url}.expect.json" }
      end
    end

    def serve(request, slug, extension)
      return [405, { "allow" => "GET, HEAD" }, []] unless request.get? || request.head?

      entry = @entries[slug]
      return unless entry

      document = extension == "arazzo" ? mounted_arazzo(entry.arazzo, request.script_name.to_s) : entry.expectations
      status, headers, body = Protocol.json(200, document, {
        "cache-control" => "no-store", "x-content-type-options" => "nosniff"
      })
      [status, headers, request.head? ? [] : body]
    end

    private

    def mounted_arazzo(document, base)
      sources = document["sourceDescriptions"]
      return document if base.empty? || !sources.is_a?(Array)

      document.merge("sourceDescriptions" => sources.map do |source|
        next source unless source.is_a?(Hash)

        url = source["url"]
        url.is_a?(String) && url.start_with?("/") && !url.start_with?("//", "#{base}/") ? source.merge("url" => base + url) : source
      end)
    end
  end
end
