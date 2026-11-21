# frozen_string_literal: true

require_relative "../testbench/lib/testbench/version"
require_relative "../gemspec_metadata"

Gem::Specification.new do |spec|
  spec.name = "testbench-rails"
  spec.version = TestBench::VERSION
  spec.authors = ["Test Bench contributors"]
  spec.summary = "Rails engine that mounts the Test Bench workbench inside a Rails API."
  spec.description = "Adds the workbench at /bench, discovers preview-enabled controller actions from the router, " \
                     "and dispatches previews through the application's real middleware and controllers."
  spec.license = "MIT"
  spec.required_ruby_version = ">= 3.3"
  TestBenchGemspec.apply(spec)

  spec.files = Dir["lib/**/*", "LICENSE", "README.md"]
  spec.require_paths = ["lib"]

  spec.add_dependency "testbench-core", TestBench::VERSION
  spec.add_dependency "railties", ">= 8.0", "< 9"
  spec.add_dependency "actionpack", ">= 8.0", "< 9"
end
