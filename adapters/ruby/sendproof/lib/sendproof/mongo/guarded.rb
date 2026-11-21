# frozen_string_literal: true

module Sendproof
  module Mongo
    # Guarded handles for the plain +mongo+ driver. The driver has no ambient session, so
    # +Store#client+ is a proxy whose +database+, +use+, +[]+ and +collection+ return proxies with the
    # driver's own API, and during a Preview every call that can send a command gets the Preview session
    # in its options:
    #
    # - a call that passes a session other than the Preview's is refused, failing the Preview with 500;
    # - +start_session+ and +with_session+ hand out the Preview session, whose transaction methods join the
    #   Preview.
    #
    # The guard itself is not here: the engine's command monitoring classifies every command before it is
    # sent, whichever handle (or none) sent it. These proxies only make the Preview session ride along, so a
    # write made through them is rolled back instead of refused as an escape. Outside a Preview every call
    # passes straight through.
    module Guarded
      # Where each driver method takes its options hash: the number of positional arguments before it.
      OPTIONS = {
        insert_one: 1, insert_many: 1, bulk_write: 1, update_one: 2, update_many: 2, replace_one: 2, delete_one: 1,
        delete_many: 1, find: 1, count_documents: 1, estimated_document_count: 0, distinct: 2, find_one_and_delete: 1,
        find_one_and_replace: 2, find_one_and_update: 2, aggregate: 1, watch: 1, drop: 0, create: 0, indexes: 0,
        command: 1, collection_names: 0, list_collections: 0, collections: 0, list_mongo_databases: 0, database_names: 0,
        list_databases: 0
      }.freeze

      # The methods that hand back another handle, so the proxy keeps wrapping.
      DERIVED = %i[[] collection database use with].freeze

      # A proxy around a +Mongo::Client+, +Mongo::Database+ or +Mongo::Collection+.
      class Handle < BasicObject
        def initialize(target, engine)
          @target = target
          @engine = engine
        end

        # @return [Object] the proxied driver object
        def __target__ = @target

        def respond_to_missing?(name, include_private = false) = @target.respond_to?(name, include_private)

        def respond_to?(name, include_private = false) = @target.respond_to?(name, include_private)

        def is_a?(klass) = @target.is_a?(klass)
        alias kind_of? is_a?

        def inspect = "#<Sendproof guarded #{@target.inspect}>"

        def ==(other) = @target == (other.respond_to?(:__target__) ? other.__target__ : other)

        def method_missing(name, *args, **kwargs, &block)
          state = @engine.state
          return derive(name, @target.public_send(name, *args, **kwargs, &block)) unless state

          if name == :start_session
            return state.session
          elsif name == :with_session
            return block.call(state.session)
          end

          result = if OPTIONS.key?(name)
                     positional, options = inject(name, args, kwargs, state)
                     @target.public_send(name, *positional, options, &block)
                   else
                     @target.public_send(name, *args, **kwargs, &block)
                   end
          derive(name, result)
        end

        private

        # Adds the Preview session to the call's options, refusing a different explicit session.
        def inject(name, args, kwargs, state)
          # The driver's methods take a trailing options hash, not keywords: Ruby packs keywords into the last
          # positional argument, so do the same (find(_id: 1) is a filter, find({}, limit: 1) has options).
          args += [kwargs] unless kwargs.empty?
          index = OPTIONS.fetch(name)
          positional = args.first(index)
          positional << nil while positional.length < index
          options = args[index].is_a?(::Hash) ? args[index] : {}
          if options[:session] && !options[:session].equal?(state.session)
            ::Kernel.raise ::Sendproof::Stores::Guard.refuse_in_preview(
              "A MongoDB call passed its own session during a Preview; the Preview session must carry every command."
            )
          end
          [positional, options.merge(session: state.session)]
        end

        def derive(name, result)
          return result unless DERIVED.include?(name) && result.class.name.to_s.start_with?("Mongo::")
          return result unless [::Mongo::Client, ::Mongo::Database, ::Mongo::Collection].any? { |klass| result.is_a?(klass) }

          Handle.new(result, @engine)
        end
      end
    end
  end
end
