Server tests now clear closed fixtures before starting the next one, so a failed
setup reports its real error without trying to close an earlier fixture again.
The test NATS fixture retries stream creation for up to ten seconds when a fresh
server misses a short JetStream request under CI load.
