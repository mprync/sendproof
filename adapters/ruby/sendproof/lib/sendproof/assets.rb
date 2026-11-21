# frozen_string_literal: true

module Sendproof
  # Serves the packed UI bundle (manifest.json plus files) embedded in the gem.
  #
  # The bundle is produced by +tools/pack-ui.mjs+ (+rake ui:pack+) and is never edited here.
  # Each file's SHA-256 is verified against the manifest before it is served.
  class Assets
    DEFAULT_DIRECTORY = File.expand_path("ui", __dir__)

    # Raised when the bundle is missing or a file does not match its manifest entry.
    class BundleError < StandardError; end

    Asset = Struct.new(:body, :content_type, :sha256)

    attr_reader :directory

    def initialize(directory = nil)
      @directory = File.expand_path(directory || DEFAULT_DIRECTORY)
      @mutex = Mutex.new
      @cache = {}
      @manifest = nil
    end

    # @return [Hash] the parsed manifest: +version+, +bundleHash+ and +files+
    def manifest
      @manifest ||= begin
        path = File.join(directory, "manifest.json")
        raise BundleError, "The Sendproof UI bundle is missing (#{path}). Run `rake ui:pack`." unless File.file?(path)

        JSON.parse(File.read(path))
      end
    end

    # @return [Asset, nil] nil for names outside the manifest
    def find(name)
      entry = manifest.fetch("files", {})[name]
      return nil unless entry

      @mutex.synchronize { @cache[name] ||= load_asset(name, entry) }
    end

    # Rack response for +name+, honouring +If-None-Match+; nil when unknown.
    def serve(name, request)
      asset = find(name) or return nil

      etag = %("#{asset.sha256}")
      headers = { "content-type" => asset.content_type, "cache-control" => "no-cache",
                  "x-content-type-options" => "nosniff", "etag" => etag }
      return [304, headers, []] if request.get_header("HTTP_IF_NONE_MATCH") == etag

      headers["content-length"] = asset.body.bytesize.to_s
      [200, headers, request.head? ? [] : [asset.body]]
    end

    private

    def load_asset(name, entry)
      path = File.join(directory, name)
      raise BundleError, "#{name} is listed in the manifest but missing." unless File.file?(path)

      body = File.binread(path)
      unless Digest::SHA256.hexdigest(body) == entry["sha256"] && body.bytesize == entry["bytes"]
        raise BundleError, "#{name} does not match its manifest entry."
      end

      Asset.new(body.freeze, entry["contentType"], entry["sha256"])
    end
  end
end
