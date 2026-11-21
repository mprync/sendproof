# frozen_string_literal: true

require_relative "test_helper"

class LimitsTest < Minitest::Test
  def test_clip_truncates_by_characters
    assert_equal "ab", Sendproof::Limits.clip("abcdef", 2)
    assert_equal "abc", Sendproof::Limits.clip("abc", 10)
  end

  def test_snapshot_returns_plain_json
    assert_equal({ "a" => [1, nil] }, Sendproof::Limits.snapshot({ a: [1, nil] }))
  end

  def test_snapshot_rejects_oversized_strings_and_collections
    assert_nil Sendproof::Limits.snapshot("x" * (Sendproof::Limits::TEXT + 1))
    assert_nil Sendproof::Limits.snapshot((0..Sendproof::Limits::PARAMETERS).to_a)
  end

  def test_snapshot_survives_cyclic_data
    cycle = {}
    cycle[:self] = cycle
    assert_nil Sendproof::Limits.snapshot(cycle)
  end

  def test_snapshot_changes_caps_the_count_and_flags_truncation
    changes = Array.new(Sendproof::Limits::CHANGES + 5) { |i| { operation: "insert", table: "t", key: { id: i }, before: nil, after: { id: i } } }
    result, truncated = Sendproof::Limits.snapshot_changes(changes)
    assert_equal Sendproof::Limits::CHANGES, result.length
    assert truncated
  end

  def test_snapshot_changes_flags_a_value_that_cannot_be_captured
    change = { operation: "insert", table: "t", key: nil, before: nil, after: { blob: "x" * 5000 } }
    result, truncated = Sendproof::Limits.snapshot_changes([change])
    assert truncated
    assert_nil result.first[:after]
  end
end

class RedactionTest < Minitest::Test
  def test_hides_secret_words_in_any_casing_and_style
    %w[password PasswordHash api_key refreshToken secret_value client_secret].each do |name|
      assert Sendproof::Redaction.looks_secret?(name), name
    end
  end

  def test_keeps_ordinary_names_visible
    ["idempotency_key", "monkey", "primary_key", "name", "INSERT INTO items (id, name) VALUES (?, ?)"].each do |text|
      refute Sendproof::Redaction.looks_secret?(text), text
    end
  end

  def test_finds_a_secret_inside_a_statement
    assert Sendproof::Redaction.looks_secret?('UPDATE "users" SET "password_digest" = ? WHERE id = ?')
  end

  def test_oversized_payloads_are_rejected_before_serialization
    huge = { "rows" => Array.new(10) { "x" * 4000 } }
    JSON.stub(:generate, ->(*) { flunk "serialized an oversized payload" }) do
      assert_nil Sendproof::Limits.snapshot(huge)
      assert_nil Sendproof::Limits.snapshot(Array.new(1_000_000, 1))
      assert_nil Sendproof::Limits.snapshot("y" * 10_000_000)
    end
    assert_equal({ "ok" => [1, "two"] }, Sendproof::Limits.snapshot({ ok: [1, :two] }))
  end
end
