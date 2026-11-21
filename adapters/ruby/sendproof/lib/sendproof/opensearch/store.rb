# frozen_string_literal: true

module Sendproof
  module OpenSearch
    # The OpenSearch data store: a Faraday middleware on every connection of +OpenSearch::Transport+,
    # the HTTP layer of the +opensearch-ruby+ gem. See {Sendproof::Search::Store} for the behavior,
    # coverage and options. The store id is +opensearch+.
    #
    # @example
    #   config.sendproof.data_store Sendproof::OpenSearch::Store.new(name: "search")
    class Store < Sendproof::Search::Store
      def system = "opensearch"

      # @return [Class] the transport client class whose instances this store guards
      def client_class = ::OpenSearch::Transport::Client

      # @return [Class] the HTTP transport class that builds the Faraday connections
      def transport_class = ::OpenSearch::Transport::Transport::HTTP::Faraday
    end
  end
end
