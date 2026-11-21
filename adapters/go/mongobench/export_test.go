package mongobench

// ForceGuardMode makes the store behave as if hello had reported a standalone
// server, so guard mode can be tested against the replica set the tests run on.
func ForceGuardMode(s *Store) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.detected = &detection{mode: "guard", reason: StandaloneReason}
}

// ForcePreviewMode makes later detections report a replica set, as when a server
// that was unreachable at the start answers.
func ForcePreviewMode(s *Store) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.detected = &detection{mode: "preview"}
}
