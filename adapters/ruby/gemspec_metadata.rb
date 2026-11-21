# frozen_string_literal: true

# Shared by the three gemspecs. Release metadata that must never be hard-coded in a tracked file
# (the repository URL) is resolved here, so changing the canonical repository changes every gem.
#
# Resolution order:
#   1. ENV["SENDPROOF_REPOSITORY_URL"], set by tools/release/rubygems.mjs when it builds the gems.
#   2. adapters/go/MODULE_PATH, the repository's single source of truth for its own URL, when the
#      gemspec is evaluated from a checkout (for example by Bundler's `path:` gems).
# Anything else raises, so a gem can never be built with an invented repository.
module SendproofGemspec
  URL_PATTERN = %r{\Ahttps://[^/\s]+/[^/\s]+/[^/\s]+\z}

  module_function

  def repository_url
    url = ENV["SENDPROOF_REPOSITORY_URL"].to_s.strip.sub(/\.git\z/, "").chomp("/")
    url = url_from_module_path if url.empty?
    raise "SENDPROOF_REPOSITORY_URL is not set and adapters/go/MODULE_PATH was not found" if url.nil?
    raise "Repository URL must look like https://host/owner/repo, got #{url.inspect}" unless URL_PATTERN.match?(url)

    url
  end

  def url_from_module_path
    path = File.expand_path("../go/MODULE_PATH", __dir__)
    return nil unless File.file?(path)

    match = %r{\A([^/\s]+)/([^/\s]+)/([^/\s]+)/adapters/go\z}.match(File.read(path).strip)
    match && "https://#{match[1]}/#{match[2]}/#{match[3]}"
  end

  # Applies the metadata every Sendproof gem shares: homepage, source, issues, changelog, docs, MFA.
  def apply(spec)
    url = repository_url
    spec.homepage = url
    spec.metadata["source_code_uri"] = url
    spec.metadata["bug_tracker_uri"] = "#{url}/issues"
    spec.metadata["changelog_uri"] = "#{url}/releases"
    spec.metadata["documentation_uri"] = "#{url}/tree/main/adapters/ruby#readme"
    spec.metadata["rubygems_mfa_required"] = "true"
  end
end
