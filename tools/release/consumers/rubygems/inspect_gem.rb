# frozen_string_literal: true

# Prints the metadata and file list of a built .gem as JSON, without installing it.
# Usage: ruby inspect_gem.rb path/to/name-1.2.3.gem
require "json"
require "rubygems/package"

package = Gem::Package.new(ARGV.fetch(0))
spec = package.spec
puts JSON.generate(
  name: spec.name,
  version: spec.version.to_s,
  licenses: spec.licenses,
  authors: spec.authors,
  summary: spec.summary,
  description: spec.description,
  homepage: spec.homepage,
  metadata: spec.metadata,
  required_ruby_version: spec.required_ruby_version.to_s,
  dependencies: spec.runtime_dependencies.map { |d| { name: d.name, requirement: d.requirement.to_s } },
  files: package.contents
)
