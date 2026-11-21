# frozen_string_literal: true

require "rails"
require "action_controller/railtie"
require "sendproof"

module Sendproof
  # Rails integration: a Railtie that mounts the workbench, discovers preview-enabled
  # controller actions from the router, and anchors preview transactions at the real action.
  module Rails
    autoload :Configuration, "sendproof/rails/configuration"
    autoload :Controller, "sendproof/rails/controller"
    autoload :LogSink, "sendproof/rails/log_sink"
    autoload :Routes, "sendproof/rails/routes"
  end
end

require "sendproof/rails/engine"
