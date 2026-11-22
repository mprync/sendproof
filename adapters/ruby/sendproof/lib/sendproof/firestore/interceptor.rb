# frozen_string_literal: true

module Sendproof
  module Firestore
    # The gRPC client interceptor that hands every Firestore call to the store before it is sent. It
    # covers all four call types. A unary or server-streaming call passes its request message; a client
    # or bidirectional stream passes none, so the store classifies it by RPC name alone: +Listen+ is a
    # read, and +Write+, which can't be read before its first message, is refused before it opens.
    #
    # The interceptor holds no state. It asks {Sendproof::Firestore.store} on each call.
    class Interceptor < ::GRPC::ClientInterceptor
      def request_response(request: nil, call: nil, method: nil, metadata: nil, &send)
        guarded(method, request, &send)
      end

      def server_streamer(request: nil, call: nil, method: nil, metadata: nil, &send)
        guarded(method, request, &send)
      end

      def client_streamer(requests: nil, call: nil, method: nil, metadata: nil, &send)
        guarded(method, nil, &send)
      end

      def bidi_streamer(requests: nil, call: nil, method: nil, metadata: nil, &send)
        guarded(method, nil, &send)
      end

      private

      def guarded(method, message, &send)
        store = Sendproof::Firestore.store
        return send.call unless store&.active?

        store.around(method, message, &send)
      end
    end
  end
end
