# frozen_string_literal: true

require "rails"
require "action_controller/railtie"
require "testbench"

module TestBench
  # Rails integration: a Railtie that mounts the workbench, discovers preview-enabled
  # controller actions from the router, and anchors preview transactions at the real action.
  module Rails
    autoload :Configuration, "testbench/rails/configuration"
    autoload :Controller, "testbench/rails/controller"
    autoload :LogSink, "testbench/rails/log_sink"
    autoload :Routes, "testbench/rails/routes"
  end
end

require "testbench/rails/engine"
