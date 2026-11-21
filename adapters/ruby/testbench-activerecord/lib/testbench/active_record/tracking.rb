# frozen_string_literal: true

require "base64"

module TestBench
  module ActiveRecord
    # Model callbacks, mixed into +ActiveRecord::Base+, that feed the active {Tracker}.
    # They do nothing when no preview or observed send is running.
    module Tracking
      extend ActiveSupport::Concern

      included do
        after_create { Tracking.created(self) }
        after_update { Tracking.updated(self) }
        after_destroy { Tracking.destroyed(self) }
        after_rollback { Tracking.rolled_back(self) }
      end

      class << self
        def created(record)
          tracker = Tracker.current or return
          tracker.record(record, change("insert", record, nil, row(record, tracker), tracker))
        end

        def updated(record)
          tracker = Tracker.current or return
          saved = record.saved_changes
          return if saved.empty?

          current = row(record, tracker)
          before = current.merge(saved.to_h { |name, (old, _)| [name, value(old, tracker)] })
          tracker.record(record, change("update", record, before, current, tracker))
        end

        def destroyed(record)
          tracker = Tracker.current or return
          tracker.record(record, change("delete", record, row(record, tracker), nil, tracker))
        end

        def rolled_back(record)
          Tracker.current&.rolled_back(record)
        end

        private

        def change(operation, record, before, after, tracker)
          { operation:, table: record.class.table_name, key: key(record, tracker), before:, after: }
        end

        def key(record, tracker)
          primary_key = record.class.primary_key
          return nil if primary_key.nil?

          Array(primary_key).to_h { |name| [name, value(record[name], tracker)] }
        end

        def row(record, tracker)
          attributes = record.attributes
          tracker.truncate! if attributes.length > Limits::PARAMETERS
          attributes.first(Limits::PARAMETERS).to_h { |name, item| [name, value(item, tracker)] }
        end

        # Reduces a column value to plain JSON data without raising.
        def value(item, tracker)
          case item
          when nil, true, false, Integer then item
          when Float then item.finite? ? item : item.to_s
          when String
            return Base64.strict_encode64(item[0, Limits::TEXT * 3 / 4]) if item.encoding == Encoding::BINARY

            clipped = Limits.clip(item)
            tracker.truncate! if clipped.length != item.length
            clipped
          when Symbol then item.to_s
          else
            json = item.as_json
            json.is_a?(String) ? Limits.clip(json) : json
          end
        end
      end
    end
  end
end
