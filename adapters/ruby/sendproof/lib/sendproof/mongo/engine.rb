# frozen_string_literal: true

require "json"
require "set"

module Sendproof
  module Mongo
    # The per-client engine shared by {Store} (plain driver) and {Sendproof::Mongoid::Store}:
    #
    # - *Topology.* +hello+ decides the mode once. A replica set or mongos with logical sessions runs in
    #   +preview+ mode; anything else in +guard+ mode (spec/data-stores.md "Starting the transaction").
    # - *Session.* Each +preview+-mode Preview gets one client session with a snapshot/majority
    #   transaction. The handler's own +start_transaction+ and +with_transaction+ join it; its
    #   +commit_transaction+ and +abort_transaction+ never reach the server and fail the Preview with 500.
    # - *Guard and tripwire.* Every command the client sends is seen by {Subscriber#started} on the
    #   calling thread before it is written. During a Preview it is classified and refused: in +guard+
    #   mode every write blocks, in +preview+ mode what MongoDB can't run in a transaction blocks, and a
    #   write that doesn't carry the Preview's +lsid+ and +autocommit: false+ fails the Preview with 500.
    #   A reply with code 263 blocks, and every other command becomes a +Db+ log entry.
    # - *Finish.* After the handler, changes are read (inside the transaction for +after+, and at the
    #   transaction's own snapshot time for +before+), then the transaction is aborted and the session
    #   ended. A Preview that outlives its time limit is aborted early and answers 500. An abort the
    #   server never acknowledged (the connection dropped) answers 500 at once and is followed, in the
    #   background, by +killSessions+, so the transaction doesn't hold its locks until the server's
    #   lifetime limit.
    class Engine
      # Commands the monitoring specification marks security-sensitive: never logged.
      SENSITIVE = %w[authenticate saslstart saslcontinue getnonce createuser updateuser copydbgetnonce copydbsaslstart copydb].to_set.freeze

      # Fields the driver adds to every command; they carry no meaning for the log and are dropped.
      ENVELOPE = %w[lsid txnNumber autocommit startTransaction $clusterTime $db $readPreference readConcern writeConcern
                    apiVersion apiStrict apiDeprecationErrors].to_set.freeze

      # Most candidate documents read back for change capture in one Preview.
      CANDIDATE_LIMIT = 1000

      # The default Preview time limit in seconds: below the server's 60-second
      # +transactionLifetimeLimitSeconds+, so the binding, not the server, ends a Preview whose handler
      # runs too long.
      DEFAULT_TIMEOUT = 50.0

      # Server error codes meaning the collection or snapshot didn't exist at the start time.
      ABSENT_AT_START = [26, 246].freeze # NamespaceNotFound, SnapshotUnavailable

      # Databases whose commands can't join a transaction.
      SYSTEM_DATABASES = %w[admin config local].freeze

      # +NoSuchTransaction+: the server has no such transaction, so nothing holds its locks.
      NO_SUCH_TRANSACTION = 251

      # How long, in seconds, the engine keeps trying to end a Preview transaction whose abort the server
      # never acknowledged, and the backoff between tries: well inside the server's 60-second lifetime.
      KILL_RETRY_LIMIT = 10.0
      KILL_FIRST_DELAY = 0.1
      KILL_MAX_DELAY = 2.0

      # The state of one +preview+-mode Preview.
      # +start_time+ is the transaction's snapshot time: the +operationTime+ of the first reply to a command
      # the Preview session sent, so +before+ images are read at that time and a concurrent commit by
      # another request never shows up as a Preview change. +lock+ makes the time limit and the finish take
      # turns: only one of them ever aborts the transaction, and neither is interrupted while it does.
      # +opened+ is set once a command carrying the Preview session was sent: from then on the server may
      # hold the transaction, and its locks, until an abort reaches it. +killer+ is the background thread
      # that ends a transaction whose abort was lost; it ends the session itself once done, so the session
      # id isn't reused meanwhile.
      State = Struct.new(:mode, :session, :lsid, :used, :opened, :finished, :expired, :candidates, :filters, :start_time,
                         :timer, :lock, :killer, keyword_init: true)

      # One document a Preview may have changed, and how.
      Candidate = Struct.new(:namespace, :collection, :id, :via)

      # A filter whose matches, before and inside the transaction, are change candidates.
      Filter = Struct.new(:namespace, :collection, :filter, :via)

      # A command seen by monitoring, kept until its reply arrives.
      Pending = Struct.new(:capture, :preview, :name, :namespace, :target, :statement, :started, :command)

      # @return [Mongo::Client] the hooked client
      attr_reader :client
      # @return [Subscriber] the command subscriber on the hooked client and on every client derived from it
      attr_reader :subscriber

      # @param client [Mongo::Client] the client to hook; its command monitoring must be on (the default)
      # @param reads [Set<String>, nil] host-declared reads, lower case
      # @param preview_timeout [Numeric] seconds a Preview may hold its transaction
      # @param hello [#call, nil] test seam: returns the +hello+ document instead of asking the server
      # @param logger [#warn, nil] where a Preview transaction the engine couldn't end is reported;
      #   +Kernel#warn+ (standard error) when nil
      def initialize(client, reads: nil, preview_timeout: DEFAULT_TIMEOUT, hello: nil, logger: nil)
        raise ArgumentError, "preview_timeout must be a positive number of seconds." unless preview_timeout.is_a?(Numeric) && preview_timeout.positive?

        # The guard sees commands only through monitoring: a client that doesn't publish them would run every
        # write unguarded, so it is refused rather than hooked.
        if client.options[:monitoring] == false
          raise ArgumentError, "Create the Mongo::Client without monitoring: false: the Preview guard needs command monitoring."
        end

        @client = client
        @reads = reads
        @timeout = preview_timeout
        @hello = hello
        @logger = logger
        @detect_lock = Mutex.new
        @detected = nil
        @active = true
        @subscriber = Subscriber.new(self)
        client.subscribe(::Mongo::Monitoring::COMMAND, @subscriber)
        Engine.registry << self
      end

      class << self
        # The engines that may own a Preview session, so Mongoid's ambient-session lookup can find them.
        def registry = @registry ||= []

        # Subscribes every hooked engine of +source+ to +derived+, a client +source.with+ returned. When
        # +with+ changes an option outside the driver's CRUD set (+app_name+, +socket_timeout+,
        # +monitoring+ ...), the driver builds a new cluster with a fresh Monitoring that has none of the
        # source's subscribers, so the derived client's commands would bypass the guard and the tripwire.
        # Its sessions belong to the new cluster, so in +preview+ mode its writes are refused as escapes.
        def carry(source, derived)
          target = derived.monitoring
          return if target.equal?(source.monitoring)

          subscribed = source.monitoring.subscribers[::Mongo::Monitoring::COMMAND] || []
          registry.each do |engine|
            next unless subscribed.include?(engine.subscriber)
            next if (target.subscribers[::Mongo::Monitoring::COMMAND] || []).include?(engine.subscriber)

            target.subscribe(::Mongo::Monitoring::COMMAND, engine.subscriber)
          end
        end
      end

      # Prepended to +Mongo::Client+ so a client derived with {#with} stays hooked (see {Engine.carry}).
      module DerivedClients
        def with(new_options = nil)
          super.tap { |derived| Engine.carry(self, derived) }
        end
      end
      ::Mongo::Client.prepend(DerivedClients)

      # Turns the hook off: nothing is guarded or logged afterwards. The subscriber stays on the client.
      def unhook!
        @active = false
        Engine.registry.delete(self)
      end

      def active? = @active

      # @return [Boolean] whether +client+'s commands reach this engine's subscriber
      def hooked?(client)
        (client.monitoring.subscribers[::Mongo::Monitoring::COMMAND] || []).include?(@subscriber)
      end

      # Runs engine-internal commands (topology, change capture, abort) without logging or tripping.
      def internal
        previous = Thread.current[:sendproof_mongo_internal]
        Thread.current[:sendproof_mongo_internal] = true
        yield
      ensure
        Thread.current[:sendproof_mongo_internal] = previous
      end

      def internal? = Thread.current[:sendproof_mongo_internal] ? true : false

      # Detects the topology once: +preview+ on a replica set or mongos with logical sessions, +guard+ with
      # {STANDALONE_REASON} for a standalone server or any reply this doesn't recognize. When the +hello+
      # can't be sent or answered, +guard+ with {UNREACHABLE_REASON} for now, and it is asked again next time.
      # @return [Hash] +:mode+ and, in +guard+ mode, the +:reason+
      def detect
        return @detected if @detected

        @detect_lock.synchronize do
          return @detected if @detected

          hello = begin
            internal { @hello ? @hello.call : @client.use("admin").database.command(hello: 1).first }
          rescue ::Mongo::Error::OperationFailure
            nil # The server answered, with an error: not a reply that supports transactions.
          rescue StandardError
            return { mode: :guard, reason: UNREACHABLE_REASON }
          end
          transactions = hello.is_a?(Hash) && (hello["setName"] || hello["msg"] == "isdbgrid") &&
                         !hello["logicalSessionTimeoutMinutes"].nil?
          @detected = transactions ? { mode: :preview } : { mode: :guard, reason: STANDALONE_REASON }
        end
      end

      # @return [State, nil] the current Preview's state, when this code runs in a +preview+-mode Preview that began
      def state(recorder = Capture.preview)
        recorder&.store_state(self)&.then { |state| state.session ? state : nil }
      end

      # Raises the Preview's refusal when its MongoDB transaction is gone: the Preview has ended (handler
      # finished) or expired (time limit). Guarded handles call it first, so a late call from a thread the
      # handler left behind fails with the Preview's own error instead of reaching the driver.
      # @raise [PreviewTransactionControl]
      def refuse_if_ended(state)
        return unless state.finished || state.expired

        message = if state.expired
                    "The Preview ran longer than #{@timeout} s, so its MongoDB transaction was aborted."
                  else
                    "The Preview has ended, so its MongoDB session refuses every further call."
                  end
        preview = Capture.preview
        raise(preview ? refuse(preview, message) : PreviewTransactionControl.new(message))
      end

      # The Preview session for +client+ (any client sharing this engine's cluster), or nil. Mongoid asks
      # this for every operation so its writes carry the Preview's session.
      def preview_session_for(client)
        return nil unless @active && client && (current = state)
        return nil if current.finished || current.expired

        client.cluster.equal?(@client.cluster) ? current.session : nil
      end

      # Prepares a Preview: detects the mode and, in +preview+ mode, starts the Preview's session and
      # transaction. The session's own transaction methods are replaced so the handler joins the Preview
      # transaction instead of ending it.
      def begin_preview(recorder)
        return unless @active && recorder.store_state(self).nil?

        # The tripwire must be on the guarded client itself: without it, nothing would be guarded or rolled back.
        unless hooked?(@client)
          raise ConfigurationError, "The MongoDB client's command monitor was removed, so the Preview can't guard it."
        end

        mode = detect[:mode]
        unless mode == :preview
          recorder.set_store_state(self, State.new(mode: mode))
          return
        end
        session = @client.start_session(causal_consistency: false)
        lift_direct_connection_checks(session)
        session.start_transaction(read_concern: { level: :snapshot }, write_concern: { w: :majority })
        join_transaction(session, recorder)
        state = State.new(mode: mode, session: session, lsid: hex(session.session_id), used: false, opened: false, finished: false,
                          expired: false, candidates: {}, filters: [], lock: Mutex.new)
        recorder.set_store_state(self, state)
        # A handler still running at the limit loses its transaction: later commands fail, nothing commits,
        # and the Preview answers 500 when it ends.
        state.timer = Thread.new do
          Thread.current.report_on_exception = false
          sleep @timeout
          expire(recorder, state)
        end
      end

      # After the handler: capture document changes, then abort the transaction and end the session. A
      # capture read that fails for any reason but an already-aborted transaction raises, after the abort, so
      # the Preview answers 500, as does an abort the server never acknowledged. Nothing the Preview wrote
      # is ever committed: no +commitTransaction+ is ever sent for the Preview session.
      def finish_preview(recorder)
        current = recorder.store_state(self)
        # Bookkeeping for commands this thread never saw finish (a refused command is never sent).
        Thread.current[:sendproof_mongo_refused]&.clear
        Thread.current[:sendproof_mongo_pending]&.clear
        return unless current&.session

        failure = nil
        # Waits for a time limit that is aborting the transaction right now, rather than racing it.
        current.lock.synchronize do
          next if current.finished

          begin
            internal { capture_changes(recorder, current) } if current.used && !current.expired
          rescue StandardError => error
            # A failed command inside a transaction makes the server abort it: nothing to capture.
            failure = error unless error.is_a?(::Mongo::Error::OperationFailure) && error.code == 251 # NoSuchTransaction
          ensure
            end_session(current)
          end
          if current.killer && !current.expired
            # The server may still hold the transaction's locks; the session is killed in the background.
            failure ||= PreviewTransactionControl.new("MongoDB didn't acknowledge the abort of the Preview transaction, " \
                                                      "so the rollback can't be confirmed.")
          end
        end
        # The timer is asleep, waiting for the lock or done: never stopped in the middle of an abort.
        current.timer&.kill unless current.timer.equal?(Thread.current)
        raise failure if failure
      end

      # ---- Monitoring ----

      # Called by the subscriber before a command is written. During a Preview it classifies the command
      # and raises to refuse it: the driver propagates the exception, so no byte of it is sent.
      def command_started(event)
        # The driver sends abortTransaction only when a command was sent in the transaction.
        aborting = Thread.current[:sendproof_mongo_aborting]
        aborting[:sent] = true if aborting && event.command_name == "abortTransaction"
        return unless @active && !internal?

        name = event.command_name
        lower = name.downcase
        command = event.command
        # The driver redacts a security-sensitive command to an empty document, which would classify as an
        # unknown command, so a write. Classify by the command's name instead: an authentication exchange on
        # a new pooled connection must never block a Preview.
        command = { name => 1 } if command.nil? || command.empty?
        classification = if SENSITIVE.include?(lower)
                           Stores::Classify::MongoResult.new(:session, nil)
                         else
                           Stores::Classify.mongo(command, @reads)
                         end
        preview = Capture.preview
        if preview
          begin
            check(preview, event, command, classification)
          rescue Sendproof::PreviewWriteBlocked, Sendproof::PreviewTransactionControl
            # If a driver ever swallowed this, the command would be sent: command_succeeded/failed then fault.
            (Thread.current[:sendproof_mongo_refused] ||= Set.new) << event.request_id
            raise
          end
          # Not refused, so it is sent: on the Preview session, the server now holds the transaction.
          if (current = state_for(preview)) && !current.opened && hex(command["lsid"]) == current.lsid
            current.opened = true
          end
        elsif classification.kind == :write
          # Not this request's Preview: a write from outside any request is refused before it is sent while
          # a Preview is open, and blocks every open Preview (409) in either mode, since nothing was sent.
          Attribution.refuse_unattributed("mongodb", name)
        end
        return if classification.kind == :session || SENSITIVE.include?(lower)

        target = command[name].is_a?(String) ? command[name] : nil
        # Literals become "?" but the command's own target (the collection name) stays, as the spec's example shows.
        body = command.reject { |field, _| ENVELOPE.include?(field.to_s) }
        statement = Stores::Guard.sanitize_document(body)
        statement[name] = target if target && statement.key?(name)
        return unless Capture.current

        (Thread.current[:sendproof_mongo_pending] ||= {})[event.request_id] =
          Pending.new(Capture.current, preview, name, event.database_name, target,
                      JSON.generate(statement), Clock.now, command)
      end

      def command_succeeded(event)
        acknowledge_abort(event, nil)
        return unless @active

        tripwire(event)
        pending = take(event) or return
        reply = event.reply || {}
        state = pending.preview && state_for(pending.preview)
        # The first reply in the transaction carries its snapshot time (the read timestamp).
        if state && state.start_time.nil? && reply["operationTime"] && hex(pending.command["lsid"]) == state.lsid
          state.start_time = reply["operationTime"]
        end
        track_reply(state, pending, reply) if state && pending.target
        cursor = reply["cursor"]
        rows = if cursor then (cursor["firstBatch"] || cursor["nextBatch"] || []).length
               elsif reply["n"].is_a?(Integer) then reply["n"]
               end
        log(pending, event.duration, rows)
      end

      def command_failed(event)
        failure = event.failure
        failure = {} unless failure.respond_to?(:key?)
        # A network error has no failure document: it proves nothing reached the server.
        acknowledge_abort(event, failure["code"]) if failure["code"]
        return unless @active

        tripwire(event)
        pending = take(event) or return
        # The server refused something a transaction can't do and applied nothing: a block, not a crash.
        if pending.preview && state_for(pending.preview) && failure["code"] == 263
          pending.preview.block(store: "mongodb", operation: pending.name, detail: Mongo.refused_reason(pending.name))
        end
        log(pending, event.duration, nil, failure["codeName"] || "Error")
      end

      private

      def state_for(recorder) = recorder.store_state(self)&.then { |state| state.session ? state : nil }

      # The driver hides the outcome of +abortTransaction+, so monitoring notes it while the engine aborts:
      # the abort counts when the server acknowledged it or answered that the transaction no longer exists.
      def acknowledge_abort(event, code)
        aborting = Thread.current[:sendproof_mongo_aborting]
        return unless aborting && event.command_name == "abortTransaction"

        aborting[:acknowledged] = true if code.nil? || code == NO_SUCH_TRANSACTION
      end

      def mode_of(recorder) = recorder.store_state(self)&.mode || :guard

      def hex(lsid)
        data = lsid && (lsid["id"] || lsid[:id])
        data.respond_to?(:data) ? data.data.unpack1("H*") : nil
      end

      # Classifies a command during a Preview and refuses it.
      def check(preview, event, command, classification)
        name = event.command_name
        state = state_for(preview)
        if %w[committransaction aborttransaction].include?(name.downcase)
          raise refuse(preview, "Preview owns the MongoDB transaction, so the handler's #{name} cannot run during Preview.")
        end
        raise refuse(preview, "The Preview ran longer than #{@timeout} s, so its MongoDB transaction was aborted.") if state&.expired

        if mode_of(preview) == :preview && !SYSTEM_DATABASES.include?(event.database_name)
          if (refused = classification.refused_in_transaction)
            Stores::Guard.guard("mongodb", name, :write, Mongo.refused_reason(refused))
          end
          verify_in_transaction(preview, state, event, command) if classification.kind == :write
        else
          Stores::Guard.guard("mongodb", name, classification.kind)
        end
      end

      # A write seen during a Preview: it must carry the Preview's session and transaction, or nothing can
      # roll it back. Otherwise it is refused (and, were the driver ever to send it anyway, the fault stands).
      def verify_in_transaction(preview, state, event, command)
        name = event.command_name
        unless state && !state.finished && hex(command["lsid"]) == state.lsid && command["autocommit"] == false
          raise refuse(preview, "A MongoDB #{name} escaped the Preview session; the Preview can't be confirmed.")
        end

        state.used = true
        collect(state, event.database_name, name.downcase, command)
      end

      def refuse(preview, message)
        Stores::Guard.refuse_in_preview(message) || PreviewTransactionControl.new(message).tap { |error| preview.refuse(error) }
      end

      # If a driver ever sent a command the hook refused, the Preview can't be confirmed.
      def tripwire(event)
        refused = Thread.current[:sendproof_mongo_refused]
        return unless refused&.delete?(event.request_id)

        Capture.preview&.refuse(PreviewTransactionControl.new("A refused MongoDB #{event.command_name} reached the server; the Preview can't be confirmed."))
      end

      def take(event)
        pending = Thread.current[:sendproof_mongo_pending]
        pending&.delete(event.request_id)
      end

      # Collects the candidate documents of a write: ids named in the command, and filters whose matches
      # (before and inside the transaction) are read back at the end.
      def collect(state, namespace, name, command)
        collection = command[command.keys.first].is_a?(String) ? command[command.keys.first] : ""
        case name
        when "insert"
          Array(command["documents"]).each { |document| candidate(state, Candidate.new(namespace, collection, document["_id"], nil)) }
        when "update"
          Array(command["updates"]).each do |update|
            via = update["upsert"] ? :upsert : (replaces?(update["u"]) ? :replace : nil)
            state.filters << Filter.new(namespace, collection, update["q"] || {}, via)
          end
        when "delete"
          Array(command["deletes"]).each { |remove| state.filters << Filter.new(namespace, collection, remove["q"] || {}, nil) }
        when "findandmodify"
          via = command["upsert"] ? :upsert : (replaces?(command["update"]) ? :replace : nil)
          state.filters << Filter.new(namespace, collection, command["query"] || {}, via)
        when "bulkwrite"
          collect_bulk(state, namespace, command)
        end
      end

      # The client-level bulkWrite command: each op names its namespace by index.
      def collect_bulk(state, namespace, command)
        return unless command["ops"].is_a?(Array) && command["nsInfo"].is_a?(Array)

        namespaces = command["nsInfo"].map { |info| info["ns"].to_s.split(".", 2) }
        command["ops"].each do |op|
          index = op["insert"] || op["update"] || op["delete"]
          database, target = namespaces[index] || [namespace, ""]
          if op["document"]
            candidate(state, Candidate.new(database, target.to_s, op["document"]["_id"], nil))
          else
            state.filters << Filter.new(database, target.to_s, op["filter"] || {}, op["upsert"] ? :upsert : nil)
          end
        end
      end

      def candidate(state, candidate)
        return if candidate.id.nil?

        key = [candidate.namespace, candidate.collection, Plain.call(candidate.id).to_json]
        known = state.candidates[key]
        state.candidates[key] = candidate if known.nil? || (known.via.nil? && candidate.via)
      end

      # Whether an update document replaces the whole document rather than applying operators.
      def replaces?(update)
        update.is_a?(Hash) && !update.empty? && !update.keys.first.to_s.start_with?("$")
      end

      # Upserted ids appear only in the reply; findAndModify returns the changed document.
      def track_reply(state, pending, reply)
        Array(reply["upserted"]).each do |upsert|
          candidate(state, Candidate.new(pending.namespace, pending.target, upsert["_id"], :upsert))
        end
        value = reply["value"]
        if pending.name.casecmp?("findAndModify") && value.is_a?(Hash) && !value["_id"].nil?
          candidate(state, Candidate.new(pending.namespace, pending.target, value["_id"], nil))
        end
        upserted = reply.dig("lastErrorObject", "upserted") if reply["lastErrorObject"].is_a?(Hash)
        candidate(state, Candidate.new(pending.namespace, pending.target, upserted, :upsert)) unless upserted.nil?
      end

      def log(pending, duration, rows, error = nil)
        pending.capture&.db(system: "mongodb", operation: pending.name, namespace: pending.namespace, target: pending.target,
                            statement: pending.statement, rows_affected: rows, error: error,
                            duration_ms: duration ? duration * 1000.0 : Clock.elapsed_ms(pending.started))
      end

      # ---- Session and transaction ----

      # A direct connection (one seed, no replica set name) is a "single" topology to the driver, which then
      # refuses transactions and non-primary read preferences itself even though the server was verified as
      # a replica set member by +hello+; those two client-side checks are lifted for the Preview session only.
      def lift_direct_connection_checks(session)
        return unless @client.cluster.single?

        session.define_singleton_method(:check_transactions_supported!) { nil }
        session.define_singleton_method(:validate_read_preference!) { |_command| nil }
      end

      # Makes the handler's own transaction calls join the Preview transaction, and refuses the ones that
      # would end it. Call after the transaction has started: it replaces +start_transaction+.
      def join_transaction(session, recorder)
        refuse_call = lambda do |what|
          error = PreviewTransactionControl.new("Preview owns the MongoDB transaction, so the handler's #{what} cannot run during Preview.")
          recorder.refuse(error)
          error
        end
        session.define_singleton_method(:start_transaction) { |*_args| nil }
        session.define_singleton_method(:with_transaction) { |*_args, &block| block.call(self) }
        session.define_singleton_method(:commit_transaction) { |*_args| raise refuse_call.call("commit_transaction") }
        session.define_singleton_method(:abort_transaction) { |*_args| raise refuse_call.call("abort_transaction") }
        session.define_singleton_method(:end_session) { nil }
      end

      # Aborts the Preview transaction and ends its session, once; call it holding +state.lock+. When the
      # abort was lost, the background kill ends the session once it is done instead.
      def end_session(state)
        return if state.finished

        state.finished = true
        abort_or_kill(state)
        release(state.session) unless state.killer
      end

      # The Preview outlived its time limit: it can never be confirmed, and its transaction is aborted now.
      def expire(recorder, state)
        state.lock.synchronize do
          next if state.finished

          state.expired = true
          recorder.refuse(PreviewTransactionControl.new("The Preview ran longer than #{@timeout} s, so its MongoDB transaction was aborted."))
          abort_or_kill(state)
        end
      end

      # Aborts the Preview transaction. The driver ignores abort errors, as the transactions specification
      # requires: an unacknowledged abort still commits nothing, because no +commitTransaction+ is ever sent
      # for the Preview session. But the server then keeps the transaction, and its locks, until its
      # 60-second lifetime limit. So when a command was sent on the session (+state.opened+, or the driver
      # sent its abort) and no reply acknowledged the abort, a background thread ends the transaction with
      # +killSessions+ ({#kill}) and sets +state.killer+. The driver may not even send the abort: a dropped
      # connection can leave it no server to select.
      def abort_or_kill(state)
        session = state.session
        return if state.killer || !session.in_transaction?

        aborting = { sent: false, acknowledged: false }
        previous = Thread.current[:sendproof_mongo_aborting]
        Thread.current[:sendproof_mongo_aborting] = aborting
        begin
          internal { ::Mongo::Session.instance_method(:abort_transaction).bind(session).call }
        rescue StandardError
          nil
        ensure
          Thread.current[:sendproof_mongo_aborting] = previous
        end
        return if aborting[:acknowledged] || !(state.opened || aborting[:sent])

        state.killer = Thread.new do
          Thread.current.report_on_exception = false
          internal { kill(session) }
        ensure
          release(session, discard: true)
        end
      end

      # Ends a Preview transaction whose abort no reply acknowledged with +killSessions+ on its session,
      # retrying with backoff while the server can't be reached. A final failure is logged with the session
      # id: the server then ends the transaction, and releases its locks, at its lifetime limit.
      def kill(session)
        deadline = Clock.now + KILL_RETRY_LIMIT
        delay = KILL_FIRST_DELAY
        failure = begin
          loop do
            @client.use("admin").database.command(killSessions: [session.session_id])
            return
          rescue ::Mongo::Error::OperationFailure => error
            break error.message
          rescue StandardError => error
            # A network error or no server to select: try again shortly.
            break "MongoDB couldn't be reached for #{KILL_RETRY_LIMIT.to_i} s (#{error.class})" if Clock.now + delay > deadline

            sleep delay
            delay = [delay * 2, KILL_MAX_DELAY].min
          end
        end
        message = "Sendproof couldn't end a MongoDB Preview transaction (session #{hex(session.session_id)}): #{failure}. " \
                  "The server ends it, and releases its locks, at transactionLifetimeLimitSeconds."
        @logger ? @logger.warn(message) : Kernel.warn(message)
      end

      # Ends the driver session. After a lost abort (+discard+) its server session is marked dirty, so the
      # driver drops it rather than hand its id to another operation.
      def release(session, discard: false)
        internal do
          session.dirty! if discard && session.respond_to?(:dirty!)
          ::Mongo::Session.instance_method(:end_session).bind(session).call
        end
      rescue StandardError
        nil
      end

      # ---- Change capture ----

      # Finds documents as they were when the Preview transaction started: a snapshot read at its start
      # time, outside the transaction. The driver has no read-concern option for +atClusterTime+, so the read
      # is a raw +find+ command. Without a start time (no reply carried one), it reads the majority-committed
      # view, which the spec allows: nothing the Preview wrote is committed, so the only difference is a
      # concurrent commit by another request.
      def at_start(state, namespace, collection, filter, projection = nil)
        read_concern = state.start_time.nil? ? { level: "majority" } : { level: "snapshot", atClusterTime: state.start_time }
        command = { find: collection, filter: filter, batchSize: CANDIDATE_LIMIT, limit: CANDIDATE_LIMIT, singleBatch: true,
                    readConcern: read_concern }
        command[:projection] = projection if projection
        reply = @client.use(namespace).database.command(command).first
        reply.dig("cursor", "firstBatch") || []
      rescue ::Mongo::Error::OperationFailure => error
        # The collection was created after the start time: nothing in it existed then.
        return [] if ABSENT_AT_START.include?(error.code)

        raise
      end

      # Compares each candidate's start-time and in-transaction versions and records the differences.
      def capture_changes(recorder, state)
        session = state.session
        state.filters.each do |filter|
          target = @client.use(filter.namespace)[filter.collection]
          matches = target.find(filter.filter, projection: { _id: 1 }, session: session).to_a + at_start(state, filter.namespace, filter.collection, filter.filter, { _id: 1 })
          matches.each do |document|
            candidate(state, Candidate.new(filter.namespace, filter.collection, document["_id"], filter.via))
            break if state.candidates.size >= CANDIDATE_LIMIT
          end
        end
        read = 0
        state.candidates.each_value do |candidate|
          if (read += 1) > CANDIDATE_LIMIT
            recorder.truncate_changes
            break
          end
          target = @client.use(candidate.namespace)[candidate.collection]
          before = at_start(state, candidate.namespace, candidate.collection, { _id: candidate.id }).first
          after = target.find({ _id: candidate.id }, session: session).first
          was = before && Plain.call(before)
          now = after && Plain.call(after)
          next if was == now

          operation = was.nil? ? "insert" : (now.nil? ? "delete" : "update")
          change = { operation: operation, store: "mongodb", namespace: candidate.namespace, table: candidate.collection,
                     key: { "_id" => Plain.call(candidate.id) }, before: was, after: now }
          change[:via] = candidate.via.to_s if candidate.via && operation != "delete"
          recorder.change(change)
        end
      end
    end
  end
end
