# frozen_string_literal: true

require "json"
require "securerandom"
require "digest"
require "rack"

require_relative "sendproof/version"

# Sendproof: an in-app workbench that previews what an API call will do.
#
# The core speaks bench protocol v1 over plain Rack. Framework adapters
# (sendproof-rails) and data-layer providers (sendproof-activerecord) plug into
# the interfaces documented in {Sendproof::Provider} and {Sendproof::Handler}.
module Sendproof
  # Raised when the host configuration cannot work.
  class ConfigurationError < StandardError; end

  # Raised by a framework adapter when the endpoint selected by the router is not preview-enabled.
  class IneligibleHandler < StandardError; end

  # The Rack environment key that holds the active {PreviewRequest} or {ObservedRequest}.
  ENV_KEY = "sendproof.request"

  autoload :Assets, "sendproof/assets"
  autoload :Capture, "sendproof/capture"
  autoload :Clock, "sendproof/clock"
  autoload :Configuration, "sendproof/configuration"
  autoload :Handler, "sendproof/handler"
  autoload :Identity, "sendproof/identity"
  autoload :Owner, "sendproof/identity"
  autoload :Limits, "sendproof/limits"
  autoload :Middleware, "sendproof/middleware"
  autoload :ObservedRequest, "sendproof/observed_request"
  autoload :OperationMatcher, "sendproof/operation_matcher"
  autoload :PreviewRequest, "sendproof/preview_request"
  autoload :PreviewTransport, "sendproof/preview_transport"
  autoload :Protocol, "sendproof/protocol"
  autoload :Provider, "sendproof/provider"
  autoload :ProviderContext, "sendproof/provider"
  autoload :Recorder, "sendproof/recorder"
  autoload :Redaction, "sendproof/redaction"
  autoload :TraceStore, "sendproof/trace_store"
  autoload :Workbench, "sendproof/workbench"

  class << self
    # @return [Boolean] true while a rollback preview is running on this thread.
    def preview?
      Capture.current&.rollback? || false
    end

    # @return [Boolean] true while a preview or observed send captures this thread's request.
    def capturing?
      !Capture.current.nil?
    end

    # Records an intended side effect and tells the caller whether to skip it.
    #
    # During a preview the effect is recorded and suppressed (returns true). During an
    # observed send it is recorded as delivered and the caller proceeds (returns false).
    # Outside both, nothing is recorded and the caller proceeds.
    #
    # @param kind [String, Symbol] a conventional kind (email, http, job, message) or any label
    # @param description [String] display text
    # @param data [Hash, nil] JSON-serializable detail; see spec/README.md for conventional keys
    # @return [Boolean] true when the host must suppress delivery
    def record_effect(kind, description, data = nil)
      Capture.current&.record_effect(kind.to_s, description.to_s, data) || false
    end

    # Records the effect, then runs the block unless a preview suppressed it.
    # @return [Object, nil] the block's value, or nil when suppressed
    def deliver(kind, description, data = nil)
      yield unless record_effect(kind, description, data)
    end

    # Records an email effect. Returns true when delivery must be skipped.
    def record_email(description, from:, to:, subject:, text:, cc: [], html: nil)
      record_effect(:email, description, { from:, to: Array(to), cc: Array(cc), subject:, text:, html: })
    end

    # Records an outbound HTTP call. Returns true when the call must be skipped.
    def record_http(description, method:, url:, status: nil, body: nil)
      record_effect(:http, description, { method:, url:, status:, body: })
    end

    # Records a background job. Returns true when scheduling must be skipped.
    def record_job(description, name:, arguments: nil, queue: nil, run_at: nil)
      record_effect(:job, description, { name:, arguments:, queue:, runAt: run_at&.iso8601 })
    end

    # Records a published message. Returns true when publishing must be skipped.
    def record_message(description, topic:, payload: nil, key: nil)
      record_effect(:message, description, { topic:, payload:, key: })
    end

    # Adds an application log entry to the active capture. Returns false when nothing is capturing.
    # @param level [String] one of Trace, Debug, Information, Warning, Error, Critical
    def log(level, message)
      Capture.current&.record_log(level.to_s, message.to_s) || false
    end
  end
end
