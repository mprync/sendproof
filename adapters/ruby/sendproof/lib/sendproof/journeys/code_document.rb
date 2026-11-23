# frozen_string_literal: true

require "date"

module Sendproof
  class Journeys
    # Builds one document pair against the same OpenAPI endpoint clients discover.
    class CodeDocument
      class OpenApiError < ConfigurationError; end

      HTTP_METHODS = %w[get put post delete options head patch trace query].freeze

      def self.operations(app, url)
        response = Rack::MockRequest.new(app).get(url.to_s, "HTTP_ACCEPT" => "application/json", "HTTP_HOST" => "localhost")
        raise "HTTP #{response.status}" unless response.ok?

        document = JSON.parse(response.body)
        paths = document.fetch("paths", {})
        raise "expected an OpenAPI paths object" unless paths.is_a?(Hash)

        paths.each_with_object({}) do |(path, item), operations|
          item = path_item(document, item)
          next unless item.is_a?(Hash)

          HTTP_METHODS.each do |method|
            operation = item[method]
            next unless operation.is_a?(Hash)

            id = operation["operationId"]
            operations[id] = [method.upcase, path] if id.is_a?(String)
          end
        end
      rescue StandardError => error
        raise OpenApiError, "Could not read the OpenAPI document at #{url}: #{error.message}"
      end

      def self.path_item(document, item)
        reference = item["$ref"] if item.is_a?(Hash)
        return item unless reference.is_a?(String) && reference.start_with?("#/")

        reference.delete_prefix("#/").split("/").reduce(document) do |node, segment|
          node[segment.gsub("~1", "/").gsub("~0", "~")] if node.is_a?(Hash)
        end
      end
      private_class_method :path_item

      def initialize(slug, name, source_name, definition)
        @slug = slug
        @name = name
        @source_name = source_name.to_s
        @definition = definition
      end

      def build(config, operations, ids)
        definitions = Definitions.new(config)
        definitions.instance_eval(&@definition)
        arazzo = {
          "arazzo" => "1.1.0", "info" => { "title" => @name, "version" => "1.0.0" },
          "sourceDescriptions" => [{ "name" => @source_name, "url" => config.open_api_url, "type" => "openapi" }],
          "workflows" => []
        }
        expectations = { "sendproofExpectations" => "1.0", "arazzo" => "#{@slug}.arazzo.json",
                         "journeys" => {}, "approvedDifferences" => [] }
        problems = definitions.problems
        approvals = Set.new

        definitions.journeys.each do |journey|
          found = journey.validate(operations, config)
          found << "Duplicate workflow ID #{journey.id.inspect}." if ids.include?(journey.id)
          records = journey.approvals
          record_ids = records.map { |record| record["id"] }
          if record_ids.uniq.size != record_ids.size || record_ids.any? { |id| approvals.include?(id) }
            found << "Approved difference IDs must be unique within a document."
          end
          if found.empty?
            ids.add(journey.id)
            approvals.merge(record_ids)
            arazzo["workflows"] << journey.workflow
            expectations["journeys"][journey.id] = journey.expectations
            expectations["approvedDifferences"].concat(records)
          else
            problems.concat(found.map { |problem| "#{journey.id}: #{problem}" })
          end
        end

        entry = Entry.new(@name, "code", arazzo, expectations) unless arazzo["workflows"].empty?
        [entry, problems]
      end
    end

    class Definitions
      attr_reader :journeys, :problems

      def initialize(config)
        @config = config
        @journeys = []
        @problems = []
      end

      def journey(id, name:, description: nil, &definition)
        journey = Definition.new(id.to_s, name, description, @config)
        journey.instance_eval(&definition)
        @journeys << journey
      rescue ConfigurationError => error
        @problems << "#{id}: #{error.message}"
      end
    end

    class Definition
      attr_reader :id, :workflow

      def initialize(id, name, description, config)
        @id = id
        @config = config
        @workflow = { "workflowId" => id, "summary" => name, "description" => description }.compact
        @metadata = {}
        @steps = []
      end

      def group(value) = @metadata["group"] = value
      def run_as(persona) = @metadata["runAs"] = persona

      def send_only(reason)
        @metadata.merge!("sendOnly" => true, "sendOnlyReason" => reason)
      end

      # Input keywords are JSON Schema, with requiredness recorded on the containing object.
      def input(name, type:, required: false, **schema)
        inputs = (@workflow["inputs"] ||= { "type" => "object", "properties" => {} })
        name = name.to_s
        raise ConfigurationError, "Duplicate input #{name.inspect}." if inputs["properties"].key?(name)

        inputs["properties"][name] = { "type" => type.is_a?(Array) ? type.map(&:to_s) : type.to_s }.merge(schema)
        (inputs["required"] ||= []) << name if required
        "$inputs.#{name}"
      end

      def output(name, expression)
        (@workflow["outputs"] ||= {})[name.to_s] = expression
      end

      def step(id, operation_id, &definition)
        id = id.to_s
        raise ConfigurationError, "Duplicate step #{id.inspect}." if @steps.any? { |step| step.id == id }

        step = Step.new(id, operation_id.to_s, @config)
        step.instance_eval(&definition) if definition
        @steps << step
        (@workflow["steps"] ||= []) << step.document
      end

      def validate(operations, config)
        problems = []
        problems << "Define at least one step." if @steps.empty?
        unavailable = config.unavailable_operations.to_h { |entry| [[entry[:method], entry[:path]], entry[:reason]] }
        inputs = @workflow.dig("inputs", "properties") || {}
        earlier = {}
        @steps.each do |step|
          operation = operations[step.document["operationId"]]
          problems << "Step #{step.id}: unknown operationId #{step.document['operationId'].inspect}." unless operation
          if !@metadata["sendOnly"] && (reason = unavailable[operation] || step.send_only_reason)
            send_only("Step #{step.id} is Send only: #{reason}")
          end
          problems.concat(reference_problems("Step #{step.id}", step.document, inputs, earlier))
          earlier[step.id] = step.document.fetch("outputs", {})
          problems.concat(reference_problems("Step #{step.id} expectations", step.expectations, inputs, earlier))
        end
        problems.concat(reference_problems("Workflow outputs", @workflow["outputs"], inputs, earlier)).uniq
      end

      def expectations
        steps = @steps.reject { |step| step.expectations.empty? }.to_h { |step| [step.id, step.expectations] }
        @metadata.merge("steps" => steps)
      end

      def approvals
        @steps.flat_map do |step|
          step.approvals.map { |record| record.merge("journey" => id, "step" => step.id) }
        end
      end

      private

      def reference_problems(where, value, inputs, outputs)
        case value
        when Hash then value.values.flat_map { |item| reference_problems(where, item, inputs, outputs) }
        when Array then value.flat_map { |item| reference_problems(where, item, inputs, outputs) }
        when String
          problems = value.scan(/(?:\A|[\s{(])\$inputs\.([\w-]+)/).filter_map do |(name)|
            "#{where}: unknown input #{name.inspect}." unless inputs.key?(name)
          end
          problems + value.scan(/(?:\A|[\s{(])\$steps\.([\w-]+)\.outputs\.([\w-]+)/).filter_map do |step, name|
            if !outputs.key?(step)
              "#{where}: #{step.inspect} is not an earlier step."
            elsif !outputs[step].key?(name)
              "#{where}: step #{step.inspect} has no output #{name.inspect}."
            end
          end
        else []
        end
      end
    end

    class Step
      attr_reader :id, :document, :expectations, :approvals, :send_only_reason

      def initialize(id, operation_id, config)
        @id = id
        @config = config
        @document = { "stepId" => id, "operationId" => operation_id }
        @expectations = {}
        @approvals = []
      end

      def run_as(persona) = @expectations["persona"] = persona

      def parameter(name, location:, value:)
        (@document["parameters"] ||= []) << { "name" => name.to_s, "in" => location.to_s, "value" => value }
      end

      def body(payload, content_type: "application/json")
        @document["requestBody"] = { "contentType" => content_type, "payload" => payload }
      end

      def succeeds_with(status) = success_criterion("$statusCode == #{Integer(status)}")

      def success_criterion(condition, context: nil, type: nil)
        (@document["successCriteria"] ||= []) << { "condition" => condition, "context" => context, "type" => type }.compact
      end

      # Returns the Arazzo runtime expression for later steps to use in parameters and bodies.
      def output(name, expression)
        (@document["outputs"] ||= {})[name.to_s] = expression
        "$steps.#{id}.outputs.#{name}"
      end

      def expect_writes(&definition)
        writes = Writes.new(@config)
        writes.instance_eval(&definition)
        @expectations.merge!(writes.document)
        @send_only_reason = writes.send_only_reason
      end

      def approve_difference(id:, target:, reason:, approved_by:, approved_on:, kind: "value", expires: nil, link: nil, **values)
        if [id, reason, approved_by, approved_on].any? { |value| value.to_s.strip.empty? }
          raise ConfigurationError, "Step #{@id}: an approved difference needs an ID, reason, approver and approval date."
        end
        unknown = values.keys - %i[expected actual]
        unless unknown.empty?
          raise ConfigurationError, "Step #{@id}: unknown approved difference fields #{unknown.join(', ')}."
        end

        record = { "id" => id.to_s, "target" => target, "kind" => kind.to_s, "reason" => reason,
                   "approvedBy" => approved_by, "approvedOn" => Date.iso8601(approved_on.to_s).iso8601,
                   "expires" => expires && Date.iso8601(expires.to_s).iso8601, "link" => link }.compact
        @approvals << record.merge(values)
      rescue Date::Error
        raise ConfigurationError, "Step #{@id}: approved difference dates must use ISO 8601."
      end
    end

    class Writes
      attr_reader :document, :send_only_reason

      def initialize(config)
        @config = config
        @document = { "writes" => [], "unlisted" => "fail" }
      end

      def nothing = @document["effects"] ||= []

      def sql(table, op, key: nil, values: nil)
        provider = @config.preview_provider
        system = provider.database_system if provider.respond_to?(:database_system)
        write(store: system || "sql", table: table.to_s, op:, key:, values:)
      end

      def mongo(collection, op, key: nil, values: nil)
        write(store: "mongodb", collection: collection.to_s, op:, key:, values:)
      end

      def redis(key, op, expiry: nil)
        write(store: "redis", key:, op: op.to_s.upcase, values: expiry.nil? ? nil : { "expiry" => expiry })
      end

      def write(store:, op:, table: nil, collection: nil, key: nil, values: nil)
        system = store.to_s
        if system == "redis" || @config.data_stores.any? { |hook| hook.system.to_s == system && hook.describe[:mode].to_s == "guard" }
          @send_only_reason ||= "it writes to #{system}, which can't roll back."
        end
        @document["writes"] << { "store" => system, "op" => op.to_s, "table" => table, "collection" => collection,
                                 "key" => key, "values" => values }.compact
      end

      def effect(kind, **fields)
        (@document["effects"] ||= []) << fields.merge("kind" => kind.to_s)
      end

      def email(**fields) = effect("email", **fields)
      def any(type = :any) = { "type" => type.to_s }
      def pattern(value) = { "pattern" => value.is_a?(Regexp) ? value.source : value }
      def changed(from, to) = { "from" => from, "to" => to }
    end
  end
end
