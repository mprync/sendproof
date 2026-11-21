# frozen_string_literal: true

require_relative "test_helper"

# spec/data-stores.md, "Transaction-control statements from the handler": what a Preview refuses
# before it reaches the database.
class TransactionControlTest < Minitest::Test
  TC = Sendproof::TransactionControl

  def test_every_mysql_escape_is_refused
    [
      "CALL sendproof_commit_probe()", "call shop.refresh()", "CALL `refresh`", "/*!50000 COMMIT */",
      "/*M!100100 CREATE TABLE t (n INT) */", "SET @@session.autocommit = 1", "SET sql_mode = '', autocommit = 1",
      "CREATE TABLE sendproof_escape_1 (n INT)", "TRUNCATE t", "LOCK TABLES t WRITE", "CHECK TABLE t",
      "STOP SLAVE", "CHANGE MASTER TO MASTER_HOST='h'", "CLONE LOCAL DATA DIRECTORY = '/x'", "IMPORT TABLE FROM '/x.sdi'",
      "SET DEFAULT ROLE ALL TO u", "EXECUTE stmt", "XA START 'x'", "PREPARE s FROM 'COMMIT'", "PREPARE s FROM @sql",
      "EXECUTE IMMEDIATE 'COMMIT'", "SELECT 1 /*! ; COMMIT */",
      # A quote inside a comment, a "#" comment, or a backslash-escaped quote never hides what follows.
      "SELECT 1 # it's\n; COMMIT; SELECT 'x'", 'SELECT "a\\" "; COMMIT; SELECT "b"', "SELECT 1--1; COMMIT",
      "SELECT $a$; COMMIT; SELECT $a$"
    ].each { |sql| assert TC.ends_transaction?(sql, mysql: true), sql }
  end

  def test_ordinary_mysql_statements_stay_allowed
    [
      "SELECT 'CALL p(); COMMIT'", "SELECT 1 /* CALL p() */", "INSERT INTO t VALUES ('a\\'; COMMIT; --')",
      "CREATE TEMPORARY TABLE t (n INT)", "SAVEPOINT s1", "ROLLBACK TO SAVEPOINT s1", "SELECT `call` FROM t",
      "UPDATE t SET checked = 1", "SET @x = 1", "SELECT 1 -- COMMIT"
    ].each { |sql| refute TC.ends_transaction?(sql, mysql: true), sql }
  end

  def test_declared_procedures_match_by_exact_name_only
    safe = TC.normalize_procedures(["refresh_totals", "shop.Rebuild"])
    ["CALL refresh_totals()", "CALL REFRESH_TOTALS", "call `refresh_totals`(1)", "CALL shop.rebuild()", "CALL `shop`.`rebuild`"].each do |sql|
      refute TC.ends_transaction?(sql, mysql: true, safe_procedures: safe), sql
    end
    ["CALL refresh_totals_all()", "CALL other.refresh_totals()", "CALL rebuild()", "CALL refresh_totals(); COMMIT",
     "CALL `refresh totals`()"].each do |sql|
      assert TC.ends_transaction?(sql, mysql: true, safe_procedures: safe), sql
    end
    ["refresh_*", "`p`", "a.b.c", "", 3].each do |bad|
      assert_raises(ArgumentError, bad.inspect) { TC.normalize_procedures([bad]) }
    end
  end

  def test_the_reserved_savepoint_cannot_be_released_or_rolled_back_to
    %w[RELEASE\ SAVEPOINT\ sendproof_preview ROLLBACK\ TO\ SAVEPOINT\ `sendproof_preview` SAVEPOINT\ SENDPROOF_PREVIEW].each do |sql|
      assert TC.ends_transaction?(sql, mysql: true, reserved: "sendproof_preview"), sql
    end
    refute TC.ends_transaction?("RELEASE SAVEPOINT sendproof_preview_2", mysql: true, reserved: "sendproof_preview")
  end

  def test_other_databases_read_standard_strings_without_backslash_escapes
    assert TC.ends_transaction?("SELECT 'a\\'; COMMIT; --'")
    refute TC.ends_transaction?("SELECT E'a\\'; COMMIT; --'")
    refute TC.ends_transaction?("SELECT $$ COMMIT $$")
    refute TC.ends_transaction?("SELECT $$ ; COMMIT $$")
    assert TC.ends_transaction?("SELECT $body$ ; COMMIT $body$; COMMIT")
    assert TC.ends_transaction?("SELECT E'a\\''; COMMIT"), "the escaped quote ends nothing; the next one does"
    assert TC.ends_transaction?("SELECT 2 #- '{a}'; COMMIT"), "# is an operator outside MySQL"
    assert TC.ends_transaction?('SELECT "a\\"; COMMIT'), "a PostgreSQL identifier has no backslash escapes"
    refute TC.ends_transaction?("CALL p()"), "CALL is refused on MySQL and MariaDB only"
    assert TC.ends_transaction?("/*! COMMIT */"), "executable comments are read as SQL everywhere, to stay strict"
  end
end
