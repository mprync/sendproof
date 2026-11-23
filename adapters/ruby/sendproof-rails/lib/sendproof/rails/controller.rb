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
        class_attribute :_sendproof_no_preview, instance_accessor: false, default: []
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

        # Marks actions +preview: false+: the workbench shows "Preview unavailable" with the reason
        # before the user tries, and a Preview of one never runs the action. Use it for an action you
        # know writes to a store Sendproof can only guard, such as Redis or DynamoDB; without the
        # mark the guard decides at run time, which is also safe. Send and observed Send still work.
        #
        #   sendproof_no_preview only: :destroy, reason: "Clears the Redis session"
        #   sendproof_no_preview only: :destroy, stores: :redis # reason: "Preview unavailable: this operation writes to Redis"
        #
        # @param only [Array<Symbol>, nil] mark just these actions
        # @param except [Array<Symbol>, nil] mark every action but these
        # @param reason [String, nil] shown in the workbench; required unless +stores+ is given
        # @param stores [Array<Symbol>, nil] the store ids the action writes (+:redis+, +:dynamodb+, +:mongodb+)
        def sendproof_no_preview(only: nil, except: nil, reason: nil, stores: nil)
          stores = Array(stores).map(&:to_s)
          text = reason || (stores.empty? ? nil : Sendproof::Stores::Guard.write_reason(stores.first))
          if text.nil? || text.strip.empty? || text.length > 512
            raise ArgumentError, "Give sendproof_no_preview a reason, or the stores the action writes."
          end

          rule = { only: only && Array(only).map(&:to_s), except: Array(except).map(&:to_s), reason: text, stores: stores }
          self._sendproof_no_preview = _sendproof_no_preview + [rule]
        end

        # @return [Boolean] whether +action+ is preview-enabled: enabled by {#sendproof_preview} and not
        #   marked by {#sendproof_no_preview}
        def sendproof_preview?(action)
          rule = _sendproof_preview or return false
          action = action.to_s
          (rule[:only].nil? || rule[:only].include?(action)) && !rule[:except].include?(action) && sendproof_unavailable(action).nil?
        end

        # @return [Hash, nil] +{reason:, stores:}+ when +action+ is marked +preview: false+
        def sendproof_unavailable(action)
          action = action.to_s
          rule = _sendproof_no_preview.find { |item| (item[:only].nil? || item[:only].include?(action)) && !item[:except].include?(action) }
          rule && { reason: rule[:reason], stores: rule[:stores] }
        end
      end

      # Runs the action inside the active preview or observed send. This is the innermost point
      # shared by every controller callback chain: nothing below it runs for a rejected request.
      def send_action(method_name, *args)
        context = request.env[Sendproof::ENV_KEY]
        return super unless context

        eligible = self.class.sendproof_preview?(method_name) ||
                   (context.respond_to?(:session_get?) && context.session_get? && !self.class.sendproof_unavailable(method_name))
        context.around_handler(request: request, eligible:) { super }
      end
    end
  end
end
