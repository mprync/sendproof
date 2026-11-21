# frozen_string_literal: true

require_relative "../sendproof/lib/sendproof/version"
require_relative "../gemspec_metadata"

Gem::Specification.new do |spec|
  spec.name = "sendproof-rails"
  spec.version = Sendproof::VERSION
  spec.authors = ["Sendproof contributors"]
  spec.summary = "Rails engine that mounts the Sendproof workbench inside a Rails API."
  spec.description = "Adds the workbench at /sendproof, discovers preview-enabled controller actions from the router, " \
                     "and dispatches previews through the application's real middleware and controllers."
  spec.license = "MIT"
  spec.required_ruby_version = ">= 3.3"
  SendproofGemspec.apply(spec)

  spec.files = Dir["lib/**/*", "LICENSE", "README.md"]
  spec.require_paths = ["lib"]

  spec.add_dependency "sendproof-core", Sendproof::VERSION
  spec.add_dependency "railties", ">= 8.0", "< 9"
  spec.add_dependency "actionpack", ">= 8.0", "< 9"
end
