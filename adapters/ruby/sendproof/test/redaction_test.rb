# frozen_string_literal: true

require_relative "test_helper"

class RedactionTest < Minitest::Test
  def test_literals_in_sql_text_are_masked_but_identifiers_are_kept
    sql = "UPDATE `items` SET `name` = 'it''s', a=12.5, b = x'0a', c1 = 1, d = 'a\\'b' WHERE id = 'z' AND t2.x = 3 AND `n 5` = 0x1F"
    assert_equal "UPDATE `items` SET `name` = ?, a=?, b = ?, c1 = ?, d = ? WHERE id = ? AND t2.x = ? AND `n 5` = ?",
                 Sendproof::Redaction.mask_literals(sql)
  end

  def test_an_unterminated_literal_is_masked_to_the_end
    assert_equal "SELECT ?", Sendproof::Redaction.mask_literals("SELECT 'unterminated secret")
  end

  def test_double_quoted_identifiers_are_kept
    assert_equal %(SELECT "a b" FROM "t1" WHERE "id" = ?), Sendproof::Redaction.mask_literals(%(SELECT "a b" FROM "t1" WHERE "id" = 7))
  end
end
