# frozen_string_literal: true

require_relative "lib/testbench/version"
require_relative "../gemspec_metadata"

Gem::Specification.new do |spec|
  spec.name = "testbench-core"
  spec.version = TestBench::VERSION
  spec.authors = ["Test Bench contributors"]
  spec.summary = "Framework-neutral Rack core for the Test Bench workbench (bench protocol v1)."
  spec.description = "Serves the embedded Test Bench UI, discovery, rollback preview transport and observed-send " \
                     "traces for any Rack application. Framework and data-layer adapters plug in through small interfaces."
  spec.license = "MIT"
  spec.required_ruby_version = ">= 3.3"
  TestBenchGemspec.apply(spec)

  spec.files = Dir["lib/**/*", "LICENSE", "README.md"]
  spec.require_paths = ["lib"]

  spec.add_dependency "rack", ">= 3.0", "< 4"
end
