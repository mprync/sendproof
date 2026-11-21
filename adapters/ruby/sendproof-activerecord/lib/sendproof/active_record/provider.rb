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
      # Adapters whose Previews take turns: MySQL and MariaDB (see {Turns}).
      SERIAL_ADAPTERS = %w[mysql2 trilogy mysql].freeze

      # The SQL provider ids the workbench has a store mark for, by Active Record adapter name.
      SYSTEMS = { "sqlite3" => "sqlite", "postgresql" => "postgresql", "postgis" => "postgresql", "mysql2" => "mysql",
                  "trilogy" => "mysql", "mysql" => "mysql", "sqlserver" => "mssql" }.freeze

      # @param database [String, nil] display label; defaults to the first connection's database name
      # @param connection_classes [Array<Class>] abstract record classes whose connections are enrolled
      # @param system [String, nil] the SQL provider id for capabilities +database.system+ (+sqlite+,
      #   +postgresql+, +mysql+, +mariadb+, +mssql+); defaults to the first connection's adapter, so pass
      #   +"mariadb"+ yourself for a MariaDB server
      # @param serialize_previews [Boolean, nil] whether Previews take turns; nil means "only on MySQL and MariaDB"
      def initialize(database: nil, connection_classes: [::ActiveRecord::Base], system: nil, serialize_previews: nil)
        super()
        @database = database
        @connection_classes = connection_classes
        @system = system
        @serialize_previews = serialize_previews
        @turns = Turns.new
      end

      # @return [String, nil] the SQL provider id, so the workbench shows the right store mark
      def database_system
        return @system if @system

        adapter = adapter_names.first
        SYSTEMS[adapter] || adapter
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
        # Wait for this provider's turn before leasing a connection (MySQL only; see {Turns}).
        session = Session.new(tracker, release_turn: serialize? ? @turns.take : nil)
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

      private

      def serialize?
        @serialize_previews.nil? ? adapter_names.any? { |adapter| SERIAL_ADAPTERS.include?(adapter) } : @serialize_previews
      end

      def adapter_names
        @connection_classes.map { |klass| klass.connection_db_config.adapter.to_s }
      rescue StandardError
        []
      end
    end
  end
end
