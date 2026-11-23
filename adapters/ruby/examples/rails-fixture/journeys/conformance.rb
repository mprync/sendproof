# frozen_string_literal: true

module Fixture
  module ConformanceJourneys
    def self.register(config)
      config.code_journeys :conformance, name: "Conformance journeys" do
        journey :createAndReadItem, name: "Create and read an item" do
          item_id = input :id, type: :string, default: "conformance-item"
          item_name = input :name, type: :string, default: "Fixture item"

          step :create, :createItem do
            body({ id: item_id, name: item_name })
            succeeds_with 201
            expect_writes do
              sql :items, :insert, values: { id: item_id, name: item_name }
              email to: "admin@example.test", subject: pattern("^Item .+$")
            end
          end

          step :read, :readItem do
            parameter :id, location: :path, value: item_id
            succeeds_with 200
            expect_writes { nothing }
          end
        end
      end
    end
  end
end
