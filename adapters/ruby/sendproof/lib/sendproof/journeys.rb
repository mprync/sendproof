# frozen_string_literal: true

require "set"

module Sendproof
  # Registered Arazzo and expectations pairs, separate from the workbench's asset directory.
  class Journeys
    autoload :CodeDocument, "sendproof/journeys/code_document"

    ROUTE = %r{\A/sendproof/journeys/([a-zA-Z0-9._-]+)\.(arazzo|expect)\.json\z}
    SLUG = /\A[a-zA-Z0-9][a-zA-Z0-9._-]*\z/
    Entry = Data.define(:name, :source, :arazzo, :expectations)

    def initialize
      @entries = {}
      @code = {}
    end

    def register(path, name: nil)
      path = File.expand_path(path)
      slug = File.basename(path).delete_suffix(".arazzo.json")
      unless path.end_with?(".arazzo.json") && slug.match?(SLUG)
        raise ConfigurationError, "Register a journey named <name>.arazzo.json."
      end
      expected = File.join(File.dirname(path), "#{slug}.expect.json")
      arazzo = JSON.parse(File.read(path))
      expectations = JSON.parse(File.read(expected))
      unless arazzo.is_a?(Hash) && expectations.is_a?(Hash)
        raise ConfigurationError, "Journey files must contain JSON objects."
      end

      title = name || arazzo.dig("info", "title") || slug
      @entries[slug] = Entry.new(title, "file", arazzo, expectations)
    rescue SystemCallError, JSON::ParserError => error
      raise ConfigurationError, "Could not load the journey pair: #{error.message}"
    end

    def register_code(slug, name:, source_name:, &definition)
      slug = slug.to_s
      unless slug.match?(SLUG) && !@code.key?(slug) && definition
        raise ConfigurationError, "Register code journeys with a unique document name and a definition block (got #{slug.inspect})."
      end

      @code[slug] = CodeDocument.new(slug, name, source_name || slug.tr(".", "-"), definition)
    end

    def code_registered? = !@code.empty?

    def load_code!(app, config)
      return unless code_registered?

      files = @entries.select { |_, entry| entry.source == "file" }
      ids = Set.new
      files.each_value do |entry|
        Array(entry.arazzo["workflows"]).each { |flow| ids.add(flow["workflowId"]) if flow.is_a?(Hash) }
      end
      operations = CodeDocument.operations(app, config.open_api_url)
      generated = @code.each_with_object({}) do |(slug, document), entries|
        if files.key?(slug)
          report(config, ["#{slug}: A file journey already uses this document name."])
          next
        end

        entry, problems = document.build(config, operations, ids)
        report(config, problems)
        entries[slug] = entry if entry
      end
      @entries = files.merge(generated)
    rescue CodeDocument::OpenApiError => error
      report(config, [error.message])
      @entries = files
    end

    def discovery(base)
      @entries.map do |slug, entry|
        url = "#{base}/sendproof/journeys/#{slug}"
        { name: entry.name, source: entry.source, arazzoUrl: "#{url}.arazzo.json", expectationsUrl: "#{url}.expect.json" }
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

    def report(config, problems)
      return if problems.empty?

      if config.environment.casecmp?("development")
        raise ConfigurationError, "Invalid code journeys:\n#{problems.join("\n")}"
      end

      problems.each do |problem|
        message = "Sendproof skipped a journey: #{problem}"
        config.logger ? config.logger.warn(message) : warn(message)
      end
    end

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
