# frozen_string_literal: true

module TestBench
  module Rails
    # {TestBench::Configuration} with Rails defaults: the Rails environment, application name,
    # routes-based preview discovery, and Rails' exception-to-status mapping.
    class Configuration < TestBench::Configuration
      # @return [Symbol] minimum level of Rails.logger entries copied into captures (default :info)
      attr_accessor :log_level

      def initialize(**options)
        @log_level = :info
        super
        self.logger ||= nil
      end

      def environment = @environment_override || ::Rails.env.to_s

      def environment=(value)
        @environment_override = value&.to_s
      end

      def api_name
        @api_name || ::Rails.application.class.module_parent_name.presence || ::Rails.application.class.name || "API"
      end

      def logger = @logger || ::Rails.logger

      def preview_operations=(operations)
        @preview_operations_set = true
        super
      end

      def resolve_target(method, path, env)
        return super if @preview_operations_set || target_resolver

        Routes.resolve(method, path)
      end

      # Defaults to Rails' own exception-to-status table (rescue_responses). The base class only
      # treats 4xx results as handled client errors; everything else stays an unconfirmed failure.
      def exception_status = @exception_status || Routes.method(:status_for_error)

      private

      # Operations come from preview-enabled controller actions unless set explicitly.
      def operations_source
        @preview_operations_set ? super : Routes.operations
      end
    end
  end
end
