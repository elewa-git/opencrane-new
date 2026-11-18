Model deadlines and retry waits can be controlled by the event store’s clock in tests.
Production timing and deadline lengths stay unchanged. ESLint prevents new direct
reads of the global monotonic clock in the models and event-store libraries.
