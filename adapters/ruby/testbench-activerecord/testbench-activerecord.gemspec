# frozen_string_literal: true

require_relative "../testbench/lib/testbench/version"

Gem::Specification.new do |spec|
  spec.name = "testbench-activerecord"
  spec.version = TestBench::VERSION
  spec.authors = ["Test Bench contributors"]
  spec.summary = "ActiveRecord preview provider for Test Bench: real SQL transactions, rolled back."
  spec.description = "Opens a non-joinable transaction on the handler's connection, captures model changes and SQL, " \
                     "and rolls everything back before the preview envelope is returned."
  spec.homepage = "https://github.com/test-bench/test-bench"
  spec.license = "MIT"
  spec.required_ruby_version = ">= 3.3"
  spec.metadata["rubygems_mfa_required"] = "true"

  spec.files = Dir["lib/**/*", "LICENSE", "README.md"]
  spec.require_paths = ["lib"]

  spec.add_dependency "testbench-core", TestBench::VERSION
  spec.add_dependency "activerecord", ">= 8.0", "< 9"
end
