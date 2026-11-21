# frozen_string_literal: true

ENV["RAILS_ENV"] = "test"

require "minitest/autorun"
require "rack/test"
require "tmpdir"
require "rails"
require "action_controller/railtie"
require "sendproof/rails"

# A persistence provider that records what the transport asked of it, so the Rails suite needs no database.
class RecordingProvider < Sendproof::Provider
  class Session < Sendproof::Provider::PreviewSession
    attr_reader :log

    def initialize = (super; @log = [])
    def rollback! = @log << :rollback
    def close = @log << :close
  end

  attr_reader :sessions

  def initialize = (super; @sessions = [])
  def database = "dummy"

  def begin_preview(_context) = Session.new.tap { |session| @sessions << session }
  def begin_observation(_context) = Sendproof::Provider::Observation.new
end

UI_DIRECTORY = Dir.mktmpdir("sendproof-rails-ui-")
File.write(File.join(UI_DIRECTORY, "index.html"), "<title>Sendproof</title>")
File.write(File.join(UI_DIRECTORY, "manifest.json"), JSON.generate(
  { "version" => "0", "bundleHash" => "x", "files" => { "index.html" => {
    "sha256" => Digest::SHA256.hexdigest("<title>Sendproof</title>"), "bytes" => 25, "contentType" => "text/html" } } }
))
Minitest.after_run { FileUtils.remove_entry(UI_DIRECTORY, true) }

PROVIDER = RecordingProvider.new

# A small but real Rails API: cookie sessions, a router, controllers with a before_action gate.
class DummyApp < Rails::Application
  config.load_defaults 8.0
  config.api_only = true
  config.eager_load = false
  config.enable_reloading = false
  config.secret_key_base = "test-only-secret-key-base"
  config.consider_all_requests_local = false
  config.hosts.clear
  config.logger = ActiveSupport::BroadcastLogger.new(ActiveSupport::Logger.new(IO::NULL, level: :debug))
  config.root = __dir__
  config.middleware.use ActionDispatch::Cookies
  config.middleware.use ActionDispatch::Session::CookieStore, key: "_dummy"

  bench = config.sendproof
  bench.environments = %w[test]
  bench.open_api_url = "/openapi.json"
  bench.ui_directory = UI_DIRECTORY
  bench.identity = lambda do |request|
    user = request.get_header("HTTP_X_USER")
    user && { name: user, role: "admin", subject: user }
  end
  bench.use PROVIDER
end

DummyApp.initialize!

class ApplicationController < ActionController::API
  before_action { head :unauthorized unless request.headers["X-User"] }
end

class ItemsController < ApplicationController
  sendproof_preview only: %i[create update touch boom]

  def index = render(json: [])

  def create
    Rails.logger.debug("hidden debug line")
    Rails.logger.info("created:#{params[:id]}")
    Sendproof.record_email("Created item", from: "a@example.test", to: ["b@example.test"], subject: "s", text: "t")
    render json: { id: params[:id] }, status: :created
  end

  def update
    render json: { name: params.require(:name) }
  end

  def touch
    session[:seen] = "yes"
    response.set_header("Set-Cookie", "inner=1; Path=/")
    render json: { ok: true }
  end

  def boom = raise("boom")
  def destroy = head(:no_content)
end

class OpenController < ActionController::API
  sendproof_preview
  def ping = render(json: { pong: true })
end

class PartialController < ApplicationController
  sendproof_preview except: :hidden
  def shown = head(:ok)
  def hidden = head(:ok)
end

class ChildController < PartialController
  def inherited_action = head(:ok)
end

# Writes to a store Sendproof can only guard: the actions that know it say so with sendproof_no_preview.
class SessionsController < ApplicationController
  sendproof_preview
  sendproof_no_preview only: :clear, reason: "Clears the Redis session"
  sendproof_no_preview only: :purge, stores: %i[redis dynamodb]

  def refresh = head(:ok)
  def clear = head(:no_content)
  def purge = head(:no_content)
end

DummyApp.routes.draw do
  post "/sessions/:id/refresh", to: "sessions#refresh"
  delete "/sessions/:id", to: "sessions#clear"
  post "/sessions/:id/purge", to: "sessions#purge"
  resources :items, only: %i[index create update destroy] do
    collection { post :boom }
    member { post :touch }
  end
  get "/items/:id", to: "items#index", constraints: { id: /\d+/ }
  post "/open/ping", to: "open#ping"
  post "/partial/shown", to: "partial#shown"
  post "/partial/hidden", to: "partial#hidden"
  post "/child/inherited", to: "child#inherited_action"
  mount ->(_env) { [200, {}, ["engine"]] }, at: "/engine"
end
