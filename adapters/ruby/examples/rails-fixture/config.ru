# frozen_string_literal: true

require_relative "app"

# BENCH_PATH_BASE mounts the whole application (workbench included) under a Rack path base,
# so nothing is served outside it.
base = ENV.fetch("BENCH_PATH_BASE", "")
if base.empty?
  run Fixture::Application
else
  map(base) { run Fixture::Application }
end
