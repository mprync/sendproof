# frozen_string_literal: true

module TestBench
  # Keeps observed-send traces for a short time, owner-scoped and bounded.
  #
  # Expiry is evaluated lazily on every reserve and read against an injectable monotonic clock,
  # so tests control retention without sleeping and no timer thread exists.
  class TraceStore
    PER_OWNER = 8
    TOTAL = 32
    READ_WAIT = 5.0

    # A trace id handed out before its result exists; readers wait for {#complete}.
    class Reservation
      attr_reader :id, :owner, :start

      def initialize(id, owner, start)
        @id = id
        @owner = owner
        @start = start
        @mutex = Mutex.new
        @condition = ConditionVariable.new
        @done = false
        @result = nil
      end

      # Publishes the trace (or nil when the send was not observed to completion).
      def complete(result)
        @mutex.synchronize do
          next if @done

          @result = result
          @done = true
          @condition.broadcast
        end
      end

      # @return [Hash, nil] the trace, or nil if it was discarded or did not finish within +timeout+
      def wait(timeout)
        deadline = Clock.now + timeout
        @mutex.synchronize do
          until @done
            remaining = deadline - Clock.now
            return nil unless remaining.positive?

            @condition.wait(@mutex, remaining)
          end
          @result
        end
      end
    end

    # @param ttl [Numeric] seconds a trace stays readable
    # @param clock [#call] returns monotonic seconds
    def initialize(ttl: 300, clock: Clock.method(:now), per_owner: PER_OWNER, total: TOTAL, wait: READ_WAIT)
      @ttl = ttl
      @clock = clock
      @per_owner = per_owner
      @total = total
      @wait = wait
      @mutex = Mutex.new
      @entries = []
    end

    # @return [Reservation]
    def reserve(owner)
      @mutex.synchronize do
        expire
        owned = @entries.select { |entry| entry.owner == owner }
        remove(owned.first) if owned.length >= @per_owner
        remove(@entries.first) if @entries.length >= @total
        # 128 random bits from the CSPRNG (a UUID would carry only 122).
        Reservation.new(SecureRandom.hex(16), owner, @clock.call).tap { |entry| @entries << entry }
      end
    end

    # @return [Hash, nil] nil for unknown, expired, evicted or foreign ids
    def read(id, owner)
      return nil unless id.to_s.delete("-").match?(/\A\h{32}\z/)

      key = id.to_s.delete("-").downcase
      reservation = @mutex.synchronize do
        expire
        @entries.find { |entry| entry.id == key && entry.owner == owner }
      end
      reservation&.wait(@wait)
    end

    def discard(reservation)
      @mutex.synchronize { remove(reservation) }
    end

    # Drops everything, releasing any waiting reader.
    def clear
      @mutex.synchronize { @entries.dup.each { |entry| remove(entry) } }
    end

    private

    def expire
      now = @clock.call
      remove(@entries.first) while @entries.first && now - @entries.first.start >= @ttl
    end

    def remove(entry)
      @entries.delete(entry)
      entry&.complete(nil)
    end
  end
end
