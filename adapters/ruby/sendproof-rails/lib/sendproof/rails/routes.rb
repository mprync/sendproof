# frozen_string_literal: true

module Sendproof
  module Rails
    # Reads preview eligibility from the application's router.
    module Routes
      FORMAT = /\(\.:format\)\z/

      module_function

      # @return [Array<Array(String, String)>] +[verb, OpenAPI path template]+ for every preview-enabled route
      def operations
        ::Rails.application.routes.routes.flat_map do |route|
          next [] unless route.dispatcher? && (controller = controller_class(route.defaults[:controller]))
          next [] unless controller.respond_to?(:sendproof_preview?) && controller.sendproof_preview?(route.defaults[:action])

          verbs(route).map { |verb| [verb, template(route.path.spec.to_s)] }
        end
      end

      # @return [Array<Hash>] +{method:, path:, reason:, stores:}+ for every route marked +preview: false+
      def unavailable
        ::Rails.application.routes.routes.flat_map do |route|
          next [] unless route.dispatcher? && (controller = controller_class(route.defaults[:controller]))
          next [] unless controller.respond_to?(:sendproof_unavailable)

          mark = controller.sendproof_unavailable(route.defaults[:action]) or next []
          verbs(route).map { |verb| { method: verb, path: template(route.path.spec.to_s), **mark } }
        end
      end

      # @return [Symbol, nil] +:eligible+, +:ineligible+, or nil when the router has no such endpoint
      def resolve(method, path, session: false)
        params = ::Rails.application.routes.recognize_path(path, method: method)
        controller = controller_class(params[:controller])
        return :ineligible unless controller.respond_to?(:sendproof_preview?)
        return :eligible if session && !controller.sendproof_unavailable(params[:action])

        controller.sendproof_preview?(params[:action]) ? :eligible : :ineligible
      rescue ::ActionController::RoutingError
        nil
      end

      # Handled client errors (RecordNotFound, ParameterMissing, ...) become inner responses, as ShowExceptions would.
      def status_for_error(error)
        ::ActionDispatch::ExceptionWrapper.status_code_for_exception(error.class.name)
      end

      def controller_class(name)
        name && "#{name.camelize}Controller".safe_constantize
      end

      def verbs(route)
        route.verb.to_s.split("|").reject { |verb| verb == "HEAD" }
      end

      # +/items/:id(.:format)+ becomes +/items/{id}+; optional groups are dropped.
      def template(spec)
        spec.sub(FORMAT, "").gsub(/\([^()]*\)/, "").gsub(/[:*]([a-z_][a-zA-Z0-9_]*)/, '{\1}')
      end
    end
  end
end
