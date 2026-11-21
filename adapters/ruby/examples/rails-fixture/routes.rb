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
    %w[fail large redirect capture ordinary].each do |action|
      post "/items/:id/#{action}", to: "items##{action}", constraints: id
    end

  end
end
