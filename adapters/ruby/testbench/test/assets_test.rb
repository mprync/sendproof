# frozen_string_literal: true

require_relative "test_helper"

class AssetsTest < Minitest::Test
  def request(headers = {}, method: "GET") = Rack::Request.new(Rack::MockRequest.env_for("/", { method: }.merge(headers)))

  def test_serves_manifest_files_with_validation_headers
    status, headers, body = TestBench::Assets.new(CoreHelpers.ui_bundle).serve("app.js", request)
    assert_equal 200, status
    assert_equal "text/javascript; charset=utf-8", headers["content-type"]
    assert_equal "nosniff", headers["x-content-type-options"]
    assert_equal "no-cache", headers["cache-control"]
    assert_equal ["export {};"], body
  end

  def test_answers_a_matching_etag_with_304
    assets = TestBench::Assets.new(CoreHelpers.ui_bundle)
    etag = assets.serve("app.js", request)[1]["etag"]
    assert_equal 304, assets.serve("app.js", request({ "HTTP_IF_NONE_MATCH" => etag }))[0]
  end

  def test_head_has_headers_without_a_body
    status, headers, body = TestBench::Assets.new(CoreHelpers.ui_bundle).serve("app.js", request(method: "HEAD"))
    assert_equal 200, status
    assert_equal "10", headers["content-length"]
    assert_empty body
  end

  def test_names_outside_the_manifest_are_not_served
    assets = TestBench::Assets.new(CoreHelpers.ui_bundle)
    ["../etc/passwd", "manifest.json", "missing.js", "..%2Findex.html"].each { |name| assert_nil assets.serve(name, request), name }
  end

  def test_a_tampered_file_is_refused
    Dir.mktmpdir do |directory|
      FileUtils.cp_r(Dir[File.join(CoreHelpers.ui_bundle, "*")], directory)
      File.write(File.join(directory, "app.js"), "alert(1)")
      assert_raises(TestBench::Assets::BundleError) { TestBench::Assets.new(directory).serve("app.js", request) }
    end
  end

  def test_a_missing_bundle_explains_how_to_build_it
    error = assert_raises(TestBench::Assets::BundleError) { TestBench::Assets.new("/nonexistent").manifest }
    assert_includes error.message, "rake ui:pack"
  end
end
