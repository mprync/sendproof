# frozen_string_literal: true

module Sendproof
  module Rails
    # Mixed into ActionController. Marks actions as preview-enabled and anchors the preview at
    # the real action, after the host's before_action chain has authenticated and authorized it.
    #
    #   class ItemsController < ApplicationController
    #     sendproof_preview only: %i[create update destroy]
    #   end
    module Controller
      extend ActiveSupport::Concern

      included do
        class_attribute :_sendproof_preview, instance_accessor: false, default: nil
      end

      class_methods do
        # Enables Sendproof preview and observed send for actions of this controller.
        #
        # Enable only actions whose complete effect stays inside the configured provider's
        # transaction or is recorded through {Sendproof.record_effect}.
        #
        # @param only [Array<Symbol>, nil] enable just these actions
        # @param except [Array<Symbol>, nil] enable every action but these
        def sendproof_preview(only: nil, except: nil)
          self._sendproof_preview = { only: only && Array(only).map(&:to_s), except: Array(except).map(&:to_s) }
        end

        # @return [Boolean] whether +action+ is preview-enabled
        def sendproof_preview?(action)
          rule = _sendproof_preview or return false
          action = action.to_s
          (rule[:only].nil? || rule[:only].include?(action)) && !rule[:except].include?(action)
        end
      end

      # Runs the action inside the active preview or observed send. This is the innermost point
      # shared by every controller callback chain: nothing below it runs for a rejected request.
      def send_action(method_name, *args)
        context = request.env[Sendproof::ENV_KEY]
        return super unless context

        context.around_handler(request: request, eligible: self.class.sendproof_preview?(method_name)) { super }
      end
    end
  end
end
