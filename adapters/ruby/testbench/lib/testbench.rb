# frozen_string_literal: true

require "json"
require "securerandom"
require "digest"
require "rack"

require_relative "testbench/version"

# Test Bench: an in-app workbench that previews what an API call will do.
#
# The core speaks bench protocol v1 over plain Rack. Framework adapters
# (testbench-rails) and data-layer providers (testbench-activerecord) plug into
# the interfaces documented in {TestBench::Provider} and {TestBench::Handler}.
module TestBench
  # Raised when the host configuration cannot work.
  class ConfigurationError < StandardError; end

  # Raised by a framework adapter when the endpoint selected by the router is not preview-enabled.
  class IneligibleHandler < StandardError; end

  # The Rack environment key that holds the active {PreviewRequest} or {ObservedRequest}.
  ENV_KEY = "testbench.request"

  autoload :Assets, "testbench/assets"
  autoload :Capture, "testbench/capture"
  autoload :Clock, "testbench/clock"
  autoload :Configuration, "testbench/configuration"
  autoload :Handler, "testbench/handler"
  autoload :Identity, "testbench/identity"
  autoload :Owner, "testbench/identity"
  autoload :Limits, "testbench/limits"
  autoload :Middleware, "testbench/middleware"
  autoload :ObservedRequest, "testbench/observed_request"
  autoload :OperationMatcher, "testbench/operation_matcher"
  autoload :PreviewRequest, "testbench/preview_request"
  autoload :PreviewTransport, "testbench/preview_transport"
  autoload :Protocol, "testbench/protocol"
  autoload :Provider, "testbench/provider"
  autoload :ProviderContext, "testbench/provider"
  autoload :Recorder, "testbench/recorder"
  autoload :Redaction, "testbench/redaction"
  autoload :TraceStore, "testbench/trace_store"
  autoload :Workbench, "testbench/workbench"

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
