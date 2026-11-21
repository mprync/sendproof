# frozen_string_literal: true

require "minitest/autorun"
require "rack/test"
require "tmpdir"
require "sendproof"

# Shared helpers for the core suite: a fake persistence provider and a tiny UI bundle.
module CoreHelpers
  # A provider session that records what the transport asked of it.
  class FakeSession < Sendproof::Provider::PreviewSession
    attr_reader :log

    def initialize(changes: [], rollback_error: nil)
      super()
      @changes = changes
      @rollback_error = rollback_error
      @log = []
    end

    def changes = @changes

    def rollback!
      @log << :rollback
      raise @rollback_error if @rollback_error
    end

    def close
      @log << :close
    end
  end

  # A provider handing out {FakeSession}s and observations.
  class FakeProvider < Sendproof::Provider
    attr_reader :sessions, :observations
    attr_accessor :available, :begin_error

    def initialize(database: "fake", changes: [], rollback_error: nil)
      super()
      @database = database
      @changes = changes
      @rollback_error = rollback_error
      @available = true
      @sessions = []
      @observations = []
    end

    def available? = @available
    attr_reader :database

    def begin_preview(_context)
      raise @begin_error if @begin_error

      FakeSession.new(changes: @changes, rollback_error: @rollback_error).tap { |session| @sessions << session }
    end

    def begin_observation(_context)
      FakeObservation.new(@changes).tap { |observation| @observations << observation }
    end
  end

  class FakeObservation < Sendproof::Provider::Observation
    attr_reader :closed

    def initialize(changes)
      super()
      @changes = changes
    end

    def changes = @changes

    def close
      @closed = true
    end
  end

  # Writes a minimal UI bundle with a correct manifest and returns its directory.
  def self.ui_bundle
    @ui_bundle ||= Dir.mktmpdir("sendproof-ui-").tap do |directory|
      files = { "index.html" => ["<!doctype html><title>Sendproof</title>", "text/html; charset=utf-8"],
                "app.js" => ["export {};", "text/javascript; charset=utf-8"] }
      manifest = { "version" => "0.0.0", "bundleHash" => "x", "files" => files.to_h do |name, (body, type)|
        File.write(File.join(directory, name), body)
        [name, { "sha256" => Digest::SHA256.hexdigest(body), "bytes" => body.bytesize, "contentType" => type }]
      end }
      File.write(File.join(directory, "manifest.json"), JSON.generate(manifest))
      at_exit { FileUtils.remove_entry(directory, true) }
    end
  end

  # An enabled configuration with the static operations used throughout the suite.
  def build_config(**options)
    Sendproof::Configuration.new(
      environment: "test", environments: %w[test], open_api_url: "/openapi.json", api_name: "Fake API",
      ui_directory: CoreHelpers.ui_bundle,
      preview_operations: [%w[POST /items], %w[PATCH /items/{id}], %w[POST /boom]],
      **options
    )
  end
end
