# frozen_string_literal: true

require_relative "test_helper"

class LimitsTest < Minitest::Test
  def test_clip_truncates_by_characters
    assert_equal "ab", TestBench::Limits.clip("abcdef", 2)
    assert_equal "abc", TestBench::Limits.clip("abc", 10)
  end

  def test_snapshot_returns_plain_json
    assert_equal({ "a" => [1, nil] }, TestBench::Limits.snapshot({ a: [1, nil] }))
  end

  def test_snapshot_rejects_oversized_strings_and_collections
    assert_nil TestBench::Limits.snapshot("x" * (TestBench::Limits::TEXT + 1))
    assert_nil TestBench::Limits.snapshot((0..TestBench::Limits::PARAMETERS).to_a)
  end

  def test_snapshot_survives_cyclic_data
    cycle = {}
    cycle[:self] = cycle
    assert_nil TestBench::Limits.snapshot(cycle)
  end

  def test_snapshot_changes_caps_the_count_and_flags_truncation
    changes = Array.new(TestBench::Limits::CHANGES + 5) { |i| { operation: "insert", table: "t", key: { id: i }, before: nil, after: { id: i } } }
    result, truncated = TestBench::Limits.snapshot_changes(changes)
    assert_equal TestBench::Limits::CHANGES, result.length
    assert truncated
  end

  def test_snapshot_changes_flags_a_value_that_cannot_be_captured
    change = { operation: "insert", table: "t", key: nil, before: nil, after: { blob: "x" * 5000 } }
    result, truncated = TestBench::Limits.snapshot_changes([change])
    assert truncated
    assert_nil result.first[:after]
  end
end

class RedactionTest < Minitest::Test
  def test_hides_secret_words_in_any_casing_and_style
    %w[password PasswordHash api_key refreshToken secret_value client_secret].each do |name|
      assert TestBench::Redaction.looks_secret?(name), name
    end
  end

  def test_keeps_ordinary_names_visible
    ["idempotency_key", "monkey", "primary_key", "name", "INSERT INTO items (id, name) VALUES (?, ?)"].each do |text|
      refute TestBench::Redaction.looks_secret?(text), text
    end
  end

  def test_finds_a_secret_inside_a_statement
    assert TestBench::Redaction.looks_secret?('UPDATE "users" SET "password_digest" = ? WHERE id = ?')
  end
end
