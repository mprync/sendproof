# frozen_string_literal: true

# Models, controllers and the OpenAPI document. Loaded after the application initialized, like app/ code.

module Fixture
  class Item < ActiveRecord::Base
    self.primary_key = "id"
  end

  class BaseController < ActionController::API
    private

    def current_email = session[:email]
    def current_user = USERS[current_email]

    def authenticate!
      render json: { error: "unauthenticated" }, status: :unauthorized unless current_user
    end

    def require_admin!
      return unless current_user
      render json: { error: "forbidden" }, status: :forbidden unless current_user[:role] == "admin"
    end
  end

  class FixtureController < BaseController
    before_action :authenticate!, only: %i[personas switch_persona]
    before_action :require_admin!, only: %i[personas switch_persona]

    def ready = render(json: { ready: true })

    def sign_in
      user = USERS[params[:email]]
      return render(json: { error: "invalid credentials" }, status: :unauthorized) unless user && params[:password] == PASSWORD

      reset_session
      session[:email] = params[:email]
      render json: user
    end

    def personas
      render json: USERS.map { |email, user| { email: email, name: user[:name], role: user[:role] } }
    end

    def switch_persona
      email = params[:email]
      return head(:not_found) unless USERS.key?(email)

      reset_session
      session[:email] = email
      render json: USERS[email]
    end

    def openapi = render(json: OPENAPI)
  end

  class ItemsController < BaseController
    # Create/update/delete and the demonstration operations are previewable. `show` and `ordinary` are not.
    sendproof_preview only: %i[create update destroy fail large redirect capture]

    before_action :authenticate!
    before_action :require_admin!, except: :show

    def show
      render json: item_json(Item.find(params[:id]))
    end

    def create
      id = params[:id]
      name = params[:name]
      unless id.is_a?(String) && !id.empty? && name.is_a?(String) && !name.empty?
        return render(json: { error: "id and name are required" }, status: :unprocessable_content)
      end

      item = Item.create!(id: id, name: name)
      Rails.logger.info("created:#{id}")
      probe_secret_parameter
      notify("Created item", id)
      render json: item_json(item), status: :created
    end

    def update
      item = Item.find(params[:id])
      item.update!(name: params.require(:name))
      response.set_header("X-Fixture-Tag", params[:tag]) if params[:tag]
      render json: item_json(item)
    end

    def destroy
      Item.find(params[:id]).destroy!
      head :no_content
    end

    # Inserts, then fails: a handled 409 by default, or an unhandled exception with mode=raise.
    def fail
      Item.create!(id: params[:id], name: "will not persist")
      raise "fixture failure" if params[:mode] == "raise"

      render json: { error: "conflict" }, status: :conflict
    end

    def large
      Item.create!(id: params[:id], name: "will not persist")
      render plain: "x" * (Fixture::LARGE_BYTES), content_type: "text/plain"
    end

    def redirect
      Item.create!(id: params[:id], name: "will not persist")
      response.set_header("Set-Cookie", "inner=1; Path=/")
      response.set_header("Location", "#{request.script_name}/items/#{params[:id]}")
      head :found
    end

    # Overflows every capture limit in one request: 205 changes, 110 effects and 520 logs.
    def capture
      205.times { |n| Item.create!(id: "#{params[:id]}-#{n}", name: "bulk #{n}") }
      110.times { |n| Sendproof.record_job("Bulk job #{n}", name: "bulk", arguments: { n: n }) }
      520.times { |n| Rails.logger.info("capture:#{n}") }
      head :no_content
    end

    def ordinary
      Item.create!(id: params[:id], name: "ordinary")
      head :created
    end

    private

    def item_json(item) = { id: item.id, name: item.name }

    # A bound parameter whose name looks secret; the value must never reach a capture.
    def probe_secret_parameter
      attribute = ActiveRecord::Relation::QueryAttribute.new("fixture_secret", "fixture-secret-value",
                                                              ActiveRecord::Type::String.new)
      Item.lease_connection.select_all("SELECT ? AS fixture_secret", "Fixture probe", [attribute])
    end

    def notify(description, id)
      suppressed = Sendproof.record_email(description, from: "noreply@example.test", to: ["admin@example.test"],
                                                       subject: "Item #{id}", text: "Item #{id} was created.")
      OUTBOX << { description: description, id: id } unless suppressed
    end
  end

  LARGE_BYTES = 1024 * 1024 + 1024

  OPENAPI = begin
    item = { type: "object", required: %w[id name],
             properties: { id: { type: "string" }, name: { type: "string" } } }
    ref = { "$ref" => "#/components/schemas/Item" }
    body = ->(schema) { { required: true, content: { "application/json" => { schema: schema } } } }
    json = ->(description) { { description: description, content: { "application/json" => { schema: ref } } } }
    id_param = { name: "id", in: "path", required: true, schema: { type: "string" } }
    simple = ->(summary, status = "200") { { summary: summary, parameters: [id_param], responses: { status => { description: summary } } } }
    {
      openapi: "3.0.3",
      info: { title: "Sendproof Conformance", version: "1.0.0" },
      paths: {
        "/items" => { post: { summary: "Create an item", requestBody: body.call(ref),
                              responses: { "201" => json.call("Created"), "422" => { description: "Invalid" } } } },
        "/items/{id}" => {
          parameters: [id_param],
          get: { summary: "Read an item", responses: { "200" => json.call("The item"), "404" => { description: "Missing" } } },
          patch: { summary: "Rename an item", parameters: [{ name: "tag", in: "query", schema: { type: "string" } }],
                   requestBody: body.call({ type: "object", required: %w[name], properties: { name: { type: "string" } } }),
                   responses: { "200" => json.call("Renamed") } },
          delete: { summary: "Delete an item", responses: { "204" => { description: "Deleted" } } }
        },
        "/items/{id}/fail" => { post: simple.call("Insert, then fail", "409") },
        "/items/{id}/large" => { post: simple.call("Insert, then return an oversized body") },
        "/items/{id}/redirect" => { post: simple.call("Insert, then redirect", "302") },
        "/items/{id}/capture" => { post: simple.call("Overflow every capture limit", "204") },
        "/items/{id}/ordinary" => { post: simple.call("Insert (Send only)", "201") }
      },
      components: { schemas: { Item: item } }
    }
  end.freeze
end
