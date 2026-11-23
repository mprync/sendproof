# frozen_string_literal: true

require "set"

module Sendproof
  # Host configuration for the workbench. Everything is opt-in: with no environments listed,
  # the middleware passes every request through untouched.
  class Configuration
    # @return [String, nil] display name; defaults to "API"
    attr_writer :api_name
    # @return [String] the environment label, such as "development"
    attr_writer :environment
    # @return [String, nil] same-origin path of the primary OpenAPI document (required when enabled)
    attr_accessor :open_api_url
    # @return [Numeric] trace retention in seconds (default 300)
    attr_accessor :trace_ttl
    # @return [#call] monotonic clock in seconds, injectable for tests
    attr_accessor :trace_clock
    # @return [Boolean, nil] whether SQL parameter values are captured; nil means "only in development"
    attr_accessor :include_sql_parameter_values
    # @return [#call, nil] +request -> identity+ ({Identity.from} input); nil means anonymous
    attr_accessor :identity
    # @return [#call, nil] +request -> truthy+ gate for workbench routes and previews
    attr_accessor :authorize
    # @return [#call, nil] +method, path, env -> :eligible, :ineligible or nil+ (nil: no such endpoint)
    attr_accessor :target_resolver
    # @return [#call, nil] +error -> Integer, nil+ mapping an exception to a handled client-error status
    attr_accessor :exception_status
    # @return [String, nil] directory with the packed UI bundle; defaults to the one embedded in the gem
    attr_accessor :ui_directory
    # @return [#warn, #error, nil] where adapter problems are logged
    attr_accessor :logger
    # @return [String] the web framework named in capabilities +binding+, so the workbench shows the
    #   +preview: false+ snippet in the host's own language ("Rack" unless an adapter says otherwise)
    attr_writer :framework
    attr_reader :environments, :documents, :field_modules, :auth_providers, :providers, :data_stores

    def initialize(**options)
      @environments = Set.new
      @documents = []
      @field_modules = []
      @auth_providers = []
      @providers = []
      @data_stores = []
      @journeys = Journeys.new
      @preview_operations = []
      @preview_unavailable = []
      @trace_ttl = 300
      @trace_clock = Clock.method(:now)
      @environment = "development"
      options.each { |name, value| public_send(:"#{name}=", value) }
    end

    def api_name = @api_name || "API"
    def environment = @environment.to_s
    def framework = @framework || "Rack"
    attr_reader :journeys

    # Registers a paired Arazzo and expectations file. Relative paths use the host's working directory.
    def journey(path, name: nil)
      journeys.register(path, name:)
    end

    def preview_sessions?(provider = preview_provider)
      provider.respond_to?(:begin_held_preview) &&
        (!provider.respond_to?(:holds_preview?) || provider.holds_preview?) &&
        data_stores.all? { |store| store.describe[:mode].to_s == "guard" || store.respond_to?(:begin_held_preview) }
    end

    # A Rack application can let its router handle GETs absent from the static preview allowlist.
    def resolve_session_get(path, env)
      marks = unavailable_operations.filter_map { |entry| entry.values_at(:method, :path) if entry[:method] == "GET" }
      OperationMatcher.new(marks).resolve("GET", path) ? :ineligible : :eligible
    end

    def session_job(&block) = block
    def wait_for_session = yield

    # Replaces the environments in which the workbench and preview are served. Production is never implied.
    def environments=(list)
      @environments = Set.new(Array(list).map { |name| name.to_s.downcase })
    end

    # @return [Boolean]
    def enabled?
      environments.include?(environment.downcase)
    end

    # Adds a named same-origin OpenAPI document to the document selector.
    def open_api_document(name, url)
      @documents.reject! { |document| document[:name].casecmp?(name) }
      @documents << { name: name, url: local_url!(url) }
    end

    # Loads a host-served ES module with custom field renderers.
    def field_module(url)
      url = local_url!(url)
      @field_modules << url unless @field_modules.include?(url)
    end

    # Advertises a host-managed sign-in integration. +url+ may be nil for non-interactive handlers.
    # Use kind +cookie+ for a password JSON endpoint and +personas+ for a development persona list.
    def auth_provider(label, kind, url)
      @auth_providers << { label: label, kind: kind, url: url.nil? ? nil : local_url!(url) }
    end

    # Replaces the registered providers.
    def providers=(list)
      @providers = Array(list)
    end

    # Registers a persistence provider. Exactly one available provider must own a request.
    def use(provider)
      @providers << provider
      provider
    end

    # Registers a data store hook (+Sendproof::Redis::Store+, +Sendproof::DynamoDB::Store+,
    # +Sendproof::Mongoid::Store+ ...): any object with the {DataStore} methods. A Preview then also
    # guards that store, and capabilities list it under +dataStores+.
    def data_store(store)
      unless store.respond_to?(:describe) && store.respond_to?(:system)
        raise ConfigurationError, "A data store needs +system+ and +describe+; use Sendproof::Redis::Store, " \
                                  "Sendproof::DynamoDB::Store or Sendproof::Mongoid::Store."
      end

      @data_stores << store
      store
    end

    # Replaces the registered data stores.
    def data_stores=(list)
      @data_stores = []
      Array(list).each { |store| data_store(store) }
    end

    # Operations marked +preview: false+, or a callable returning them. Each is a hash with +:method+,
    # +:path+, +:reason+ and optionally +:stores+. Rails adapters read them from the controllers.
    def preview_unavailable=(operations)
      @preview_unavailable = operations
    end

    # @return [Array<Hash>] unique, sorted +{method:, path:, reason:, stores:}+ entries advertised in
    #   capabilities +previewUnavailable+
    def unavailable_operations
      source = unavailable_source
      source = source.call if source.respond_to?(:call)
      Array(source).map do |entry|
        operation = { method: entry[:method].to_s.upcase, path: entry[:path], reason: entry[:reason].to_s }
        operation[:stores] = Array(entry[:stores]).map(&:to_s) if entry[:stores] && !Array(entry[:stores]).empty?
        operation
      end.uniq.sort_by { |operation| [operation[:path], operation[:method]] }
    end

    # The provider that owns a preview: the one available SQL provider, or, when the host registered
    # data stores but no SQL provider, a provider with no database so the stores alone carry the preview.
    # @return [#begin_preview, nil]
    def preview_provider
      provider || (data_stores.empty? || !providers.empty? ? nil : Provider::None.new)
    end

    # Static operations, or a callable returning them. Each is +[verb, path_template]+.
    def preview_operations=(operations)
      @preview_operations = operations
    end

    # @return [Array<Hash>] unique, sorted +{method:, path:}+ entries advertised in discovery
    def operations
      operations_source.map { |verb, path| { method: verb.to_s.upcase, path: path } }
            .uniq.sort_by { |operation| [operation[:path], operation[:method]] }
    end

    # Finds out whether +method path+ is a preview-enabled endpoint.
    # @return [Symbol, nil] +:eligible+, +:ineligible+ or nil when nothing matches
    def resolve_target(method, path, env)
      return target_resolver.call(method, path, env) if target_resolver

      @matcher ||= {}
      key = operations.map { |operation| operation.values_at(:method, :path) }
      matcher = (@matcher[key] ||= OperationMatcher.new(key))
      matcher.resolve(method, path) ? :eligible : nil
    end

    # @return [Boolean] whether SQL parameter values may be shown
    def sql_parameter_values?
      include_sql_parameter_values.nil? ? environment.casecmp?("development") : include_sql_parameter_values
    end

    # @return [#begin_preview, nil] the single available provider, or nil
    def provider
      return nil unless providers.length == 1

      providers.first.available? ? providers.first : nil
    end

    # @return [Identity, nil]
    def identity_for(request)
      Identity.from(identity&.call(request))
    end

    # @return [Boolean] whether the request may use the workbench
    def authorized?(request)
      authorize.nil? || authorize.call(request) ? true : false
    end

    # @return [TraceStore]
    def trace_store
      @trace_store ||= TraceStore.new(ttl: trace_ttl, clock: trace_clock)
    end

    # Maps an exception to a handled client-error status, or nil when it is a server failure.
    def status_for_error(error)
      status = exception_status&.call(error)
      status if status.is_a?(Integer) && status >= 400 && status < 500
    end

    # @return [Assets]
    def assets
      @assets ||= Assets.new(ui_directory)
    end

    # Raises {ConfigurationError} when an enabled workbench lacks what discovery requires.
    def validate!
      return unless enabled?
      raise ConfigurationError, "Sendproof open_api_url must be set to a same-origin path." if open_api_url.nil?

      local_url!(open_api_url)
    end

    private

    # Raw +[verb, path]+ pairs; adapters override this to discover operations.
    def operations_source
      @preview_operations.respond_to?(:call) ? @preview_operations.call : @preview_operations
    end

    # The marked operations; adapters override this to discover them from their routes.
    def unavailable_source
      @preview_unavailable
    end

    # Accepts only application-relative paths. Discovery hands these URLs to the browser, which
    # loads field modules as scripts and follows sign-in links, so anything a browser could resolve
    # off-origin (+//host+, a backslash, a tab or newline it strips, a fragment) or that climbs out
    # of the mount with dot segments is refused.
    def local_url!(url)
      url = url.to_s
      return url if local_url?(url)

      raise ConfigurationError, "Use an application-relative, same-origin path (got #{url.inspect})."
    end

    def local_url?(url)
      raw = url.b
      path = raw.split("?", 2).first.to_s
      decoded = path.gsub(/%\h\h/n) { |escape| escape[1..].hex.chr }
      segments = decoded.split("/")
      path.start_with?("/") && !decoded.start_with?("//") && !raw.include?("#") && !raw.include?("\\") &&
        !decoded.include?("\\") && !raw.match?(/[\x00-\x20\x7f]/n) && !decoded.match?(/[\x00-\x1f\x7f]/n) &&
        !segments.include?(".") && !segments.include?("..")
    end
  end
end
