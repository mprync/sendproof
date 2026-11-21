# frozen_string_literal: true

require "mongoid"
require "sendproof/mongo"

module Sendproof
  # Sendproof Preview and write guard for Mongoid 9 (spec/data-stores.md "MongoDB in Preview").
  #
  #   config.sendproof.data_store Sendproof::Mongoid::Store.new(name: "catalog")
  #
  # A Preview makes its transaction session ambient for Mongoid, so models, queries and +save+ run in it
  # without any change to the application. Require it explicitly: +require "sendproof/mongoid"+.
  module Mongoid
    autoload :Store, "sendproof/mongoid/store"

    # Makes the Preview session the ambient Mongoid session for every client of a hooked cluster. Mongoid
    # asks +Threaded.get_session+ before each operation, so a model operation, including one on a client
    # derived with +with+ or +use+, carries the Preview's session.
    module AmbientSession
      def get_session(client: nil)
        super || Sendproof::Mongoid.preview_session(client)
      end
    end

    # Makes +Model.with_session+ and +Model.transaction+ join the Preview transaction instead of
    # starting a nested one (Mongoid refuses nesting). A +Mongoid::Errors::Rollback+ ends the block, but the
    # writes made so far stay in the Preview transaction, which is rolled back at the end anyway.
    module Join
      def with_session(options = {}, &block)
        session = Sendproof::Mongoid.preview_session(persistence_context.client)
        session ? block.call(session) : super
      end

      def transaction(options = {}, session_options: {}, &block)
        return super unless Sendproof::Mongoid.preview_session(persistence_context.client)

        begin
          block.call
        rescue ::Mongoid::Errors::Rollback
          nil
        end
      end
    end

    class << self
      # @return [Mongo::Session, nil] the Preview session for +client+, when this thread runs a Preview
      def preview_session(client)
        Sendproof::Mongo::Engine.registry.each do |engine|
          session = engine.preview_session_for(client)
          return session if session
        end
        nil
      end

      # Adds the two patches above to Mongoid. Idempotent.
      def install!
        return if @installed

        @installed = true
        ::Mongoid::Threaded.singleton_class.prepend(AmbientSession)
        ::Mongoid::Clients::Sessions::ClassMethods.prepend(Join)
      end
    end
  end
end
