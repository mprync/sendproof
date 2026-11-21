# frozen_string_literal: true

require "elasticsearch"
require "sendproof/search"

module Sendproof
  # Sendproof write guard for Elasticsearch (spec/data-stores.md, +guard+ mode), for the +elasticsearch+
  # 8 gem and everything built on its client, such as Searchkick, Chewy and elasticsearch-model.
  #
  #   store = Sendproof::Elasticsearch::Store.new(name: "search")
  #   config.sendproof.data_store store
  #
  # Require it explicitly: +require "sendproof/elasticsearch"+. It needs no Elasticsearch server.
  module Elasticsearch
    autoload :Store, "sendproof/elasticsearch/store"
  end
end
