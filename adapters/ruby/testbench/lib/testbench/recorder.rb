# frozen_string_literal: true

module TestBench
  # Collects effects, logs and SQL timing for one preview or observed send. Thread safe.
  class Recorder
    Snapshot = Struct.new(:effects, :logs, :logs_truncated, :effects_truncated, keyword_init: true)

    attr_reader :started

    # @param rollback [Boolean] true for a preview (effects are suppressed), false for an observed send
    # @param include_sql_values [Boolean] whether non-secret SQL parameter values are recorded
    def initialize(rollback:, started: Clock.now, include_sql_values: false)
      @rollback = rollback
      @started = started
      @include_sql_values = include_sql_values
      @mutex = Mutex.new
      @effects = []
      @logs = []
      @active = true
      @logs_truncated = false
      @effects_truncated = false
      @log_size = 0
      @effect_size = 0
      @db_ms = 0.0
      @queries = 0
      @serialize_ms = 0.0
    end

    def rollback? = @rollback

    def include_sql_values? = @include_sql_values

    def active?
      @mutex.synchronize { @active }
    end

    # Records an effect. Returns true when the host must suppress delivery (preview only).
    def record_effect(kind, description, data = nil)
      @mutex.synchronize do
        return false unless @active

        if @effects.length >= Limits::EFFECTS || @effect_size >= Limits::LOG_BUDGET
          @effects_truncated = true
          return @rollback
        end

        started = Clock.now
        captured = data.nil? ? nil : Limits.snapshot(data)
        @serialize_ms += Clock.elapsed_ms(started)
        kind_text = Limits.clip(kind, Limits::NAME)
        description_text = Limits.clip(description)
        @effect_size += kind_text.length + description_text.length + Limits.size(captured)
        @effects_truncated ||= kind_text != kind.to_s || description_text != description.to_s ||
                               (captured.nil? && !data.nil?)
        if @effect_size <= Limits::LOG_BUDGET
          effect = { kind: kind_text, description: description_text, data: captured }
          effect[:delivered] = true unless @rollback
          @effects << effect
        else
          @effects_truncated = true
        end
        @rollback
      end
    end

    # Records a plain application log message. Returns false when the recorder is finished.
    def record_log(level, message)
      log(level: level, message: message)
    end

    # Records a structured log entry.
    # @param properties [Hash, nil] string-valued properties
    # @param exception [Exception, nil]
    # @param event_id [Hash, nil] +{id:, name:}+
    def log(level:, message:, category: nil, event_id: nil, properties: nil, exception: nil)
      @mutex.synchronize do
        return false unless @active
        return true unless log_room?

        entry = { level: clip(level, Limits::NAME), message: clip(message) }
        entry[:category] = clip(category, Limits::NAME) if category
        entry[:eventId] = event_id if event_id
        entry[:offsetMs] = offset_ms
        if properties && !properties.empty?
          entry[:properties] = capture_properties(properties)
        end
        if exception
          entry[:exception] = { type: clip(exception.class.name || "Exception", Limits::NAME),
                                message: clip(exception.message) }
        end
        add_log(entry)
        true
      end
    rescue StandardError
      @mutex.synchronize { @logs_truncated = true }
      true
    end

    # Records one SQL command. The block returns +[sql_hash, truncated]+ and runs only when there is log room.
    # @param duration_ms [Float]
    def record_sql(duration_ms:, category: nil, event_id: nil)
      @mutex.synchronize do
        return unless @active

        @db_ms += duration_ms
        @queries += 1
        return unless log_room?

        begin
          sql, truncated = yield
          @logs_truncated ||= truncated
          entry = { level: "Sql", message: sql[:text] }
          entry[:category] = category if category
          entry[:eventId] = event_id if event_id
          entry[:offsetMs] = [0.0, offset_ms - duration_ms].max
          entry[:elapsedMs] = duration_ms
          entry[:sql] = sql
          add_log(entry)
        rescue StandardError
          @logs_truncated = true
        end
      end
    end

    # @return [Hash] auth, handler, db, queryCount, serialize
    def timing(clock, extra_serialize_ms = 0.0)
      @mutex.synchronize { clock.read(@db_ms, @queries, @serialize_ms, extra_serialize_ms) }
    end

    # Stops recording and returns what was captured.
    # @return [Snapshot]
    def finish
      @mutex.synchronize do
        @active = false
        snapshot = Snapshot.new(effects: @effects.dup, logs: @logs.dup,
                                logs_truncated: @logs_truncated, effects_truncated: @effects_truncated)
        @effects.clear
        @logs.clear
        snapshot
      end
    end

    private

    def offset_ms = Clock.elapsed_ms(@started)

    def clip(value, maximum = Limits::TEXT)
      text = value.to_s
      result = Limits.clip(text, maximum)
      @logs_truncated ||= result.length != text.length
      result
    end

    def log_room?
      room = @logs.length < Limits::LOGS && @log_size < Limits::LOG_BUDGET
      @logs_truncated ||= !room
      room
    end

    def add_log(entry)
      size = entry_size(entry)
      if @log_size + size <= Limits::LOG_BUDGET
        @logs << entry
        @log_size += size
      else
        @logs_truncated = true
      end
    end

    def entry_size(entry)
      size = entry[:level].length + entry[:message].length + entry[:category].to_s.length
      size += entry[:eventId][:name].to_s.length if entry[:eventId]
      entry[:properties]&.each { |name, value| size += name.length + value.length }
      size += entry[:exception][:type].length + entry[:exception][:message].length if entry[:exception]
      if (sql = entry[:sql])
        size += sql[:text].length
        sql[:parameters].each { |p| size += p[:name].length + p[:value].to_s.length + p[:dbType].length }
      end
      size
    end

    def capture_properties(properties)
      result = {}
      properties.each do |name, value|
        if result.length >= Limits::PROPERTIES
          @logs_truncated = true
          break
        end
        result[clip(name, Limits::NAME)] = clip(value)
      end
      result
    end
  end
end
