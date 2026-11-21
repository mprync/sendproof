# frozen_string_literal: true

# Loaded by Rails' route reloader; Fixture controllers live in controllers.rb.
Rails.application.routes.draw do
  scope module: :fixture do
    id = { id: %r{[^/]+} }
    get "/ready", to: "fixture#ready"
    get "/openapi/v1.json", to: "fixture#openapi"
    post "/auth/sign-in", to: "fixture#sign_in"
    get "/auth/personas", to: "fixture#personas"
    post "/auth/personas/:email", to: "fixture#switch_persona", constraints: { email: %r{[^/]+} }
    get "/items/:id", to: "items#show", constraints: id
    post "/items", to: "items#create"
    patch "/items/:id", to: "items#update", constraints: id
    delete "/items/:id", to: "items#destroy", constraints: id
    %w[fail large redirect capture ordinary commit].each do |action|
      post "/items/:id/#{action}", to: "items##{action}", constraints: id
    end
    post "/accounts", to: "accounts#create"
    get "/accounts/:id", to: "accounts#show", constraints: id

    # Data-store routes exist only when the runner passes the store's variables.
    if Fixture::STORES.any?
      post "/items/:id/remember", to: "items#remember", constraints: id
    end
    if Fixture::STORES.include?(:mongodb)
      post "/documents/archive", to: "documents#archive"
      post "/documents", to: "documents#create"
      get "/documents/:id", to: "documents#show", constraints: id
      patch "/documents/:id", to: "documents#update", constraints: id
      delete "/documents/:id", to: "documents#destroy", constraints: id
    end
    if Fixture::STORES.include?(:redis)
      key = { key: %r{[^/]+} }
      get "/counters/:key", to: "counters#show", constraints: key
      post "/counters/:key", to: "counters#increment", constraints: key
      post "/counters/:key/take", to: "counters#take", constraints: key
      delete "/counters/:key", to: "counters#destroy", constraints: key
    end
    if Fixture::STORES.include?(:dynamodb)
      get "/orders/:id", to: "orders#show", constraints: id
      post "/orders/:id/touch", to: "orders#touch", constraints: id
      post "/orders/:id/cancel", to: "orders#cancel", constraints: id
      delete "/orders/:id", to: "orders#destroy", constraints: id
    end
  end
end
