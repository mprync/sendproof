package mongobench

// ForceGuardMode makes the store behave as if hello had reported a standalone
// server, so guard mode can be tested against the replica set the tests run on.
func ForceGuardMode(s *Store) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.detected = &detection{mode: "guard", reason: StandaloneReason}
}

// SetWindowHooks runs afterCheck in a guarded call once it has passed the ended
// check, and afterAbort in the Preview's end between aborting the transaction and
// ending the session, so a test can place a late call in that window. It returns
// a function that removes them.
func SetWindowHooks(afterCheck, afterAbort func()) (restore func()) {
	windowHooks.afterCheck, windowHooks.afterAbort = afterCheck, afterAbort
	return func() { windowHooks.afterCheck, windowHooks.afterAbort = nil, nil }
}

// ForcePreviewMode makes later detections report a replica set, as when a server
// that was unreachable at the start answers.
func ForcePreviewMode(s *Store) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.detected = &detection{mode: "preview"}
}
