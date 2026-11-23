# frozen_string_literal: true

module Sendproof
  module Rails
    # {Sendproof::Configuration} with Rails defaults: the Rails environment, application name,
    # routes-based preview discovery, and Rails' exception-to-status mapping.
    class Configuration < Sendproof::Configuration
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

      def framework = @framework || "Rails"

      # Resolves relative paths from the Rails application root.
      def journey(path, name: nil)
        super(File.expand_path(path, ::Rails.application.config.root), name:)
      end

      def session_job(&block)
        # Rails uses this same execution-state handoff for streaming responses. CurrentAttributes
        # and middleware state belong to the original request even when its action runs on the worker.
        state = ActiveSupport::IsolatedExecutionState
        request_context = state.context
        lambda do |session|
          state.share_with(request_context)
          block.call(session)
        ensure
          state.clear
        end
      end

      def wait_for_session(&block)
        ActiveSupport::Dependencies.interlock.permit_concurrent_loads(&block)
      end

      def resolve_session_get(path, env)
        return :ineligible if super == :ineligible

        Routes.resolve("GET", path, session: true)
      end

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

      # Marked operations come from +sendproof_no_preview+ unless set explicitly.
      def unavailable_source
        @preview_unavailable.respond_to?(:call) || !@preview_unavailable.empty? ? super : Routes.unavailable
      end

      # Operations come from preview-enabled controller actions unless set explicitly.
      def operations_source
        @preview_operations_set ? super : Routes.operations
      end
    end
  end
end
