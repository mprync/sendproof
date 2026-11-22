# frozen_string_literal: true

module Sendproof
  # Holds the {Recorder} for the request running on the current thread (or fiber).
  #
  # Work started on other threads is not attributed to the request, with one exception: a Preview also
  # marks the fiber storage of its handler, which every thread and fiber the handler starts inherits. Store
  # hooks read that mark through {inherited_preview}, so a write such a thread sends, during the Preview or
  # long after it ended, is refused (spec/data-stores.md, "Writes the binding can't attribute to a request").
  module Capture
    KEY = :sendproof_recorder
    # Fiber storage, which Thread.new and Fiber.new copy into the thread or fiber they create.
    INHERITED = :sendproof_preview

    module_function

    # @return [Recorder, nil]
    def current
      Thread.current[KEY]
    end

    # The preview this code runs inside, even after the preview's recorder finished. Store hooks use
    # it so a write a handler sends late (after its response settled) is still refused, never sent
    # unguarded.
    #
    # @return [Recorder, nil]
    def preview
      recorder = current
      recorder if recorder&.rollback?
    end

    # The Preview whose handler started this thread or fiber (or an ancestor of it), even after that
    # Preview ended. Only store hooks consult it, and only for a write with no request of its own.
    #
    # @return [Recorder, nil]
    def inherited_preview = Fiber[INHERITED]

    # Makes +recorder+ current for the block, restoring the previous one afterwards. A Preview's recorder
    # is also left in the fiber storage that threads and fibers started inside the block inherit.
    def with(recorder)
      previous = Thread.current[KEY]
      previous_inherited = Fiber[INHERITED]
      Thread.current[KEY] = recorder
      Fiber[INHERITED] = recorder&.rollback? ? recorder : nil
      yield
    ensure
      Thread.current[KEY] = previous
      Fiber[INHERITED] = previous_inherited
    end
  end
end
