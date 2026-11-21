# frozen_string_literal: true

require_relative "stores/tables"
require_relative "stores/classify"
require_relative "stores/guard"

module Sendproof
  # Data-store support shared by every store hook: the embedded classification {Tables}, the pure
  # {Classify} functions and the write {Guard}. See spec/data-stores.md.
  module Stores
  end
end
