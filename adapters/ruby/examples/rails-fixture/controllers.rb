# frozen_string_literal: true

# Models, controllers and the OpenAPI document. Loaded after the application initialized, like app/ code.

module Fixture
  class Item < ActiveRecord::Base
    self.primary_key = "id"
  end

  class Account < ActiveRecord::Base
    self.primary_key = "id"
  end

  # A document in the Mongoid `documents` collection (spec/conformance/fixture.md): {_id, name, profile: {city}, password_hash}.
  if defined?(::Mongoid)
    class Document
      include Mongoid::Document
      store_in collection: "documents"
      field :_id, type: String
      field :name, type: String
      field :profile, type: Hash
      field :password_hash, type: String
    end
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
    sendproof_preview only: %i[create update destroy fail large redirect capture commit remember]

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

    # Inserts, then commits the transaction by hand: a Preview must refuse the COMMIT (the shared raw-commit rule).
    def commit
      Item.create!(id: params[:id], name: params.require(:name))
      Item.lease_connection.execute("COMMIT")
      render json: { id: params[:id], name: params[:name] }, status: :created
    end

    # Inserts the item, then writes the named guarded store, so SQL and a store write roll back together.
    def remember
      item = Item.create!(id: params[:id], name: params.require(:name))
      case params[:store]
      when "redis" then Fixture::REDIS.incr("#{ENV.fetch('BENCH_REDIS_PREFIX', '')}counter:item-#{params[:id]}")
      when "dynamodb" then Fixture.touch_order("item-#{params[:id]}")
      else return head(:bad_request)
      end
      render json: item_json(item), status: :created
    end

    private

    def item_json(item) = { id: item.id, name: item.name }

    # A bound parameter whose name looks secret; the value must never reach a capture. The query is real on
    # both databases: SQLite binds the parameter, and MySQL through Trilogy, which has no prepared
    # statements, quotes it into the SQL text, which the binding then logs without its literals while still
    # naming the parameter.
    def probe_secret_parameter
      attribute = ActiveRecord::Relation::QueryAttribute.new("fixture_secret", "fixture-secret-value",
                                                              ActiveRecord::Type::String.new)
      probe = Arel::SelectManager.new
      probe.project(Arel::Nodes::As.new(Arel::Nodes::BindParam.new(attribute), Arel.sql("fixture_secret")))
      Item.lease_connection.select_all(probe, "Fixture probe")
    end

    def notify(description, id)
      suppressed = Sendproof.record_email(description, from: "noreply@example.test", to: ["admin@example.test"],
                                                       subject: "Item #{id}", text: "Item #{id} was created.")
      OUTBOX << { description: description, id: id } unless suppressed
    end
  end

  # The shared security rule routes: a second table whose password_hash must never reach a capture.
  class AccountsController < BaseController
    sendproof_preview only: :create
    before_action :authenticate!

    def create
      id, email, password = params.values_at(:id, :email, :password)
      return head(:bad_request) unless [id, email, password].all? { |value| value.is_a?(String) && !value.empty? }

      Account.create!(id: id, email: email, password_hash: "hashed:#{password}")
      render json: { id: id, email: email }, status: :created
    end

    def show
      account = Account.find(params[:id])
      render json: { id: account.id, email: account.email }
    end
  end

  # MongoDB through Mongoid. In Preview the session is ambient, so these are ordinary Mongoid calls.
  class DocumentsController < BaseController
    sendproof_preview
    sendproof_no_preview only: :destroy, stores: :mongodb
    before_action :authenticate!

    def show
      document = Document.where(_id: params[:id]).first
      document ? render(json: shape(document)) : head(:not_found)
    end

    def create
      id, name, city, password = params.values_at(:id, :name, :city, :password)
      return head(:bad_request) unless [id, name, city, password].all? { |value| value.is_a?(String) && !value.empty? }

      document = Document.create!(_id: id, name: name, profile: { "city" => city }, password_hash: "hashed:#{password}")
      Rails.logger.info("created-document:#{id}")
      render json: shape(document), status: :created
    end

    def update
      return head(:not_found) unless Document.where(_id: params[:id]).exists?

      set = {}
      set["name"] = params[:name] if params[:name].is_a?(String)
      set["profile.city"] = params[:city] if params[:city].is_a?(String)
      return head(:bad_request) if set.empty?

      Document.where(_id: params[:id]).update("$set" => set)
      render json: shape(Document.where(_id: params[:id]).first)
    end

    # $out can't run inside a transaction: the Preview is blocked with that reason.
    def archive
      Document.collection.aggregate([{ "$match" => {} }, { "$out" => "documents_archive" }]).to_a
      head :no_content
    end

    def destroy
      Document.where(_id: params[:id]).delete
      head :no_content
    end

    private

    def shape(document) = { id: document._id, name: document.name, city: document.profile&.fetch("city", nil) }
  end

  # Redis through the redis gem, guarded by the redis-client middleware.
  class CountersController < BaseController
    sendproof_preview
    sendproof_no_preview only: :destroy, stores: :redis
    before_action :authenticate!

    def show
      value = REDIS.get(key)
      value.nil? ? head(:not_found) : render(json: { key: params[:key], value: value.to_i })
    end

    def increment = render(json: { key: params[:key], value: REDIS.incr(key) })

    # GETDEL looks like a read but deletes the key; a handler that swallows the refusal still gets a 409.
    def take
      value = REDIS.getdel(key)
      value.nil? ? head(:not_found) : render(json: { key: params[:key], value: value.to_i })
    end

    def destroy
      REDIS.del(key)
      head :no_content
    end

    private

    def key = "#{ENV.fetch('BENCH_REDIS_PREFIX', '')}counter:#{params[:key]}"
  end

  # DynamoDB through aws-sdk-dynamodb, guarded by the Seahorse handler.
  class OrdersController < BaseController
    sendproof_preview
    sendproof_no_preview only: :destroy, stores: :dynamodb
    before_action :authenticate!

    def show
      item = DYNAMODB.get_item(table_name: table, key: { "id" => params[:id] }).item
      item ? render(json: Fixture.order_json(item)) : head(:not_found)
    end

    def touch
      render json: Fixture.order_json(Fixture.touch_order(params[:id]).attributes)
    end

    # A PartiQL UPDATE travels through ExecuteStatement, which also carries reads.
    def cancel
      DYNAMODB.execute_statement(statement: %(UPDATE "#{table}" SET status = 'cancelled' WHERE id = ?), parameters: [params[:id]])
      render json: { id: params[:id], status: "cancelled" }
    end

    def destroy
      DYNAMODB.delete_item(table_name: table, key: { "id" => params[:id] })
      head :no_content
    end

    private

    def table = ENV.fetch("BENCH_DYNAMODB_TABLE")
  end

  # The same update the order touch route and the mixed route make.
  def self.touch_order(id)
    DYNAMODB.update_item(table_name: ENV.fetch("BENCH_DYNAMODB_TABLE"), key: { "id" => id },
                         update_expression: "ADD hits :one SET #s = if_not_exists(#s, :new)",
                         expression_attribute_names: { "#s" => "status" },
                         expression_attribute_values: { ":one" => 1, ":new" => "new" }, return_values: "ALL_NEW")
  end

  def self.order_json(item) = { id: item["id"], status: item["status"], hits: item["hits"]&.to_i }

  LARGE_BYTES = 1024 * 1024 + 1024

  OPENAPI = begin
    item = { type: "object", required: %w[id name],
             properties: { id: { type: "string" }, name: { type: "string" } } }
    ref = { "$ref" => "#/components/schemas/Item" }
    body = ->(schema) { { required: true, content: { "application/json" => { schema: schema } } } }
    json = ->(description) { { description: description, content: { "application/json" => { schema: ref } } } }
    id_param = { name: "id", in: "path", required: true, schema: { type: "string" } }
    simple = ->(summary, status = "200") { { summary: summary, parameters: [id_param], responses: { status => { description: summary } } } }
    document = {
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
    paths = document[:paths]
    paths["/accounts"] = { post: { summary: "Create an account", responses: { "201" => { description: "Created" } } } }
    paths["/accounts/{id}"] = { parameters: [id_param], get: { summary: "Read an account", responses: { "200" => { description: "The account" } } } }
    paths["/items/{id}/commit"] = { post: simple.call("Insert, then COMMIT by hand", "201") }
    if STORES.any?
      paths["/items/{id}/remember"] = { post: { summary: "Insert, then write a guarded store", parameters: [id_param,
        { name: "store", in: "query", required: true, schema: { type: "string", enum: %w[redis dynamodb] } }],
        responses: { "201" => { description: "Created" } } } }
    end
    if STORES.include?(:mongodb)
      paths["/documents"] = { post: { summary: "Create a document", responses: { "201" => { description: "Created" } } } }
      paths["/documents/archive"] = { post: { summary: "Aggregate into an archive collection ($out)", responses: { "204" => { description: "Archived" } } } }
      paths["/documents/{id}"] = { parameters: [id_param], get: { summary: "Read a document", responses: { "200" => { description: "The document" } } },
                                   patch: { summary: "Update a document", responses: { "200" => { description: "Updated" } } },
                                   delete: { summary: "Delete a document", responses: { "204" => { description: "Deleted" } } } }
    end
    if STORES.include?(:redis)
      key_param = { name: "key", in: "path", required: true, schema: { type: "string" } }
      paths["/counters/{key}"] = { parameters: [key_param], get: { summary: "Read a counter", responses: { "200" => { description: "The counter" } } },
                                   post: { summary: "Increment a counter", responses: { "200" => { description: "The counter" } } },
                                   delete: { summary: "Delete a counter", responses: { "204" => { description: "Deleted" } } } }
      paths["/counters/{key}/take"] = { parameters: [key_param], post: { summary: "Take (GETDEL) a counter", responses: { "200" => { description: "The counter" } } } }
    end
    if STORES.include?(:dynamodb)
      paths["/orders/{id}"] = { parameters: [id_param], get: { summary: "Read an order", responses: { "200" => { description: "The order" } } },
                                delete: { summary: "Delete an order", responses: { "204" => { description: "Deleted" } } } }
      paths["/orders/{id}/touch"] = { post: simple.call("Touch an order (UpdateItem)") }
      paths["/orders/{id}/cancel"] = { post: simple.call("Cancel an order (PartiQL UPDATE)") }
    end
    document
  end.freeze
end
