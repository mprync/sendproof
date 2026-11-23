# MongoDB Preview sessions

The synchronous and reactive adapters hold one MongoDB transaction across Preview steps. Each step reads the before images in that transaction and keeps an undo journal for rewind.

The session has a 1,000-document budget shared by retained undo entries, documents in collections touched by the current step, and potential inserts from that step. Before sending a write that would exceed the budget, Sendproof returns a guarded 409 and rewinds the current step. Earlier steps remain available. Rewind releases the undo entries it removes.

MongoDB's transaction lifetime still applies. If MongoDB ends the transaction, Sendproof closes the Preview session and reports `session_failed`.
