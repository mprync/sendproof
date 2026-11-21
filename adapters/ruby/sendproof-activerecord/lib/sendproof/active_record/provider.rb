# frozen_string_literal: true

module Sendproof
  module ActiveRecord
    # Preview provider for ActiveRecord.
    #
    # @example Default connection
    #   config.sendproof.use Sendproof::ActiveRecord::Provider.new
    # @example Several databases; every one the handler writes to must be listed
    #   Sendproof::ActiveRecord::Provider.new(connection_classes: [ApplicationRecord, AnalyticsRecord])
    class Provider < Sendproof::Provider
      # @param database [String, nil] display label; defaults to the first connection's database name
      # @param connection_classes [Array<Class>] abstract record classes whose connections are enrolled
      def initialize(database: nil, connection_classes: [::ActiveRecord::Base])
        super()
        @database = database
        @connection_classes = connection_classes
      end

      # @return [String, nil] a label that never contains hosts or credentials
      def database
        return @database if @database

        name = @connection_classes.first.connection_db_config.database.to_s
        name.empty? ? nil : File.basename(name, ".*")
      rescue StandardError
        nil
      end

      def begin_preview(_context)
        tracker = Tracker.new
        session = Session.new(tracker)
        begin
          @connection_classes.each { |klass| session.enroll(klass.lease_connection) }
          tracker.activate
          session
        rescue StandardError
          session.close
          raise
        end
      end

      def begin_observation(_context)
        Observation.new(Tracker.new)
      end
    end
  end
end
