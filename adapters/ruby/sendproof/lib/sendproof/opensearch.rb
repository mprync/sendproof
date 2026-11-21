# frozen_string_literal: true

require "opensearch"
require "sendproof/search"

module Sendproof
  # Sendproof write guard for OpenSearch (spec/data-stores.md, +guard+ mode), for the +opensearch-ruby+
  # 3 gem and everything built on its client.
  #
  #   store = Sendproof::OpenSearch::Store.new(name: "search")
  #   config.sendproof.data_store store
  #
  # Require it explicitly: +require "sendproof/opensearch"+.
  module OpenSearch
    autoload :Store, "sendproof/opensearch/store"
  end
end
