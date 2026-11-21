# frozen_string_literal: true

module TestBench
  # The workbench's own routes under +/bench+: UI assets, discovery and trace retrieval.
  class Workbench
    def initialize(config)
      @config = config
    end

    # @param path [String] PATH_INFO, which starts with +/bench+
    # @return [Array] Rack response
    def call(env, request, path)
      denied = authorize(request)
      return denied if denied

      case path
      when "/bench" then redirect(request)
      when "/bench/", "/bench/signin.html" then asset("index.html", request)
      when "/bench/_api/capabilities" then capabilities(request)
      when %r{\A/bench/_api/traces/([^/]+)\z} then trace(request, Regexp.last_match(1))
      when "/bench/_api/challenge" then not_found
      else
        name = path.delete_prefix("/bench/")
        name.start_with?("_") ? not_found : asset(Rack::Utils.unescape_path(name), request)
      end
    rescue Assets::BundleError => error
      @config.logger&.error("Test Bench UI bundle problem: #{error.message}")
      Protocol.problem(503, "The Test Bench UI bundle is unavailable.")
    end

    private

    def authorize(request)
      return nil if @config.authorized?(request)

      @config.identity_for(request) ? Protocol.problem(403, "The workbench is forbidden.") :
        Protocol.problem(401, "Authentication is required for the workbench.")
    end

    def not_found = [404, { "content-type" => "text/plain", "cache-control" => "no-store" }, ["Not Found"]]

    def redirect(request)
      query = request.query_string.to_s
      location = "#{request.script_name}/bench/#{query.empty? ? '' : "?#{query}"}"
      [302, { "location" => location, "content-length" => "0" }, []]
    end

    def asset(name, request)
      return [405, { "allow" => "GET, HEAD", "content-length" => "0" }, []] unless request.get? || request.head?

      @config.assets.serve(name, request) || not_found
    end

    def capabilities(request)
      provider = @config.provider
      operations = provider ? @config.operations : []
      base = request.script_name.to_s
      open_api_url = base + @config.open_api_url
      documents = @config.documents.map { |document| { name: document[:name], url: base + document[:url] } }
      documents.unshift({ name: @config.api_name, url: open_api_url }) if documents.none? { |d| d[:url] == open_api_url }
      identity = @config.identity_for(request)
      document = {
        protocolVersion: 1,
        openApiUrl: open_api_url,
        fieldModules: @config.field_modules.map { |url| base + url },
        apiName: @config.api_name,
        environment: @config.environment,
        database: provider&.database,
        identity: identity && { name: identity.name, **(identity.role ? { role: identity.role } : {}) },
        authProviders: @config.auth_providers.map { |p| p.merge(url: p[:url] && base + p[:url]) },
        previewOperations: operations,
        observedSend: !operations.empty?,
        documents:
      }
      Protocol.json(200, document, { "cache-control" => "no-store", "x-content-type-options" => "nosniff" })
    end

    def trace(request, id)
      headers = { "cache-control" => "no-store", "x-content-type-options" => "nosniff" }
      owner = Protocol.same_origin?(request) && @config.identity_for(request)&.owner(request.script_name)
      trace = owner && @config.trace_store.read(id, owner)
      return [404, headers.merge("content-type" => "text/plain"), ["Not Found"]] unless trace

      Protocol.json(200, trace, headers)
    end
  end
end
