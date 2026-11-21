# frozen_string_literal: true

require_relative "test_helper"

class TraceStoreTest < Minitest::Test
  Owner = Sendproof::Owner

  def setup
    @now = 100.0
    @store = Sendproof::TraceStore.new(ttl: 5, clock: -> { @now }, per_owner: 2, total: 3, wait: 0.05)
    @alex = Owner.new(authentication: "cookie", subject: "alex", issuer: "", path_base: "")
    @sam = Owner.new(authentication: "cookie", subject: "sam", issuer: "", path_base: "")
  end

  def test_trace_ids_carry_128_random_bits
    ids = Array.new(4) { Sendproof::TraceStore.new.reserve(:owner).id }
    assert(ids.all? { |id| id.match?(/\A\h{32}\z/) })
    # A version-4 UUID fixes six bits (the "4" nibble and the variant), so it would never vary there.
    refute(ids.all? { |id| id[12] == "4" }, "ids must not be UUIDs with fixed version bits")
  end

  def test_owner_reads_a_completed_trace
    reservation = @store.reserve(@alex)
    reservation.complete({ ok: true })
    assert_equal({ ok: true }, @store.read(reservation.id, @alex))
  end

  def test_other_owner_and_unknown_ids_get_nothing
    reservation = @store.reserve(@alex)
    reservation.complete({ ok: true })
    assert_nil @store.read(reservation.id, @sam)
    assert_nil @store.read("0" * 32, @alex)
    assert_nil @store.read("not-an-id", @alex)
  end

  def test_same_subject_on_another_mount_is_a_different_owner
    reservation = @store.reserve(@alex)
    reservation.complete({ ok: true })
    assert_nil @store.read(reservation.id, @alex.with(path_base: "/tenant"))
  end

  def test_trace_expires_when_the_clock_advances
    reservation = @store.reserve(@alex)
    reservation.complete({ ok: true })
    @now += 4.9
    refute_nil @store.read(reservation.id, @alex)
    @now += 0.2
    assert_nil @store.read(reservation.id, @alex)
  end

  def test_per_owner_and_total_limits_evict_the_oldest
    first = @store.reserve(@alex)
    second = @store.reserve(@alex)
    third = @store.reserve(@alex)
    [first, second, third].each { |r| r.complete({}) }
    assert_nil @store.read(first.id, @alex)
    refute_nil @store.read(second.id, @alex)
    @store.reserve(@sam).complete({})
    @store.reserve(@sam).complete({})
    assert_nil @store.read(second.id, @alex), "the host-wide limit evicts the oldest entry"
  end

  def test_unfinished_trace_reads_as_missing_after_the_wait
    reservation = @store.reserve(@alex)
    assert_nil @store.read(reservation.id, @alex)
  end

  def test_discard_releases_the_entry
    reservation = @store.reserve(@alex)
    @store.discard(reservation)
    assert_nil @store.read(reservation.id, @alex)
  end

  def test_reader_waits_for_completion
    reservation = @store.reserve(@alex)
    store = Sendproof::TraceStore.new(ttl: 5, wait: 2)
    waiting = store.reserve(@alex)
    Thread.new { sleep 0.05; waiting.complete({ late: true }) }
    assert_equal({ late: true }, store.read(waiting.id, @alex))
    refute_nil reservation
  end
end
