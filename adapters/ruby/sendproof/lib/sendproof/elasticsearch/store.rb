# frozen_string_literal: true

module Sendproof
  module Elasticsearch
    # The Elasticsearch data store: a Faraday middleware on every connection of +Elastic::Transport+,
    # the HTTP layer of the +elasticsearch+ gem. See {Sendproof::Search::Store} for the behavior,
    # coverage and options. The store id is +elasticsearch+; use {Sendproof::OpenSearch::Store} for OpenSearch.
    #
    # @example Guard every client in the process, built before or after this line
    #   config.sendproof.data_store Sendproof::Elasticsearch::Store.new(name: "search")
    # @example Guard one client you build yourself
    #   store = Sendproof::Elasticsearch::Store.new(name: "search", global: false)
    #   client = ::Elasticsearch::Client.new(url: url) { |faraday| store.install(faraday) }
    class Store < Sendproof::Search::Store
      def system = "elasticsearch"

      # @return [Class] the transport client class whose instances this store guards
      def client_class = ::Elastic::Transport::Client

      # @return [Class] the HTTP transport class that builds the Faraday connections
      def transport_class = ::Elastic::Transport::Transport::HTTP::Faraday
    end
  end
end
