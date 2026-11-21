# frozen_string_literal: true

require "aws-sdk-dynamodb"
require "sendproof"

module Sendproof
  # Sendproof write guard for DynamoDB (spec/data-stores.md, +guard+ mode), for +aws-sdk-dynamodb+ and
  # everything built on its client, such as +Aws::DynamoDB::Resource+ and Dynamoid.
  #
  #   store = Sendproof::DynamoDB::Store.new(client: dynamodb, name: "orders")
  #   config.sendproof.data_store store
  #
  # Require it explicitly: +require "sendproof/dynamodb"+.
  module DynamoDB
    autoload :Store, "sendproof/dynamodb/store"
  end
end
