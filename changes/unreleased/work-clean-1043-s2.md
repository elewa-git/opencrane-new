Model deadlines and retry waits can be controlled by the event store’s clock in tests.
Production timing and deadline lengths stay unchanged. ESLint prevents new direct
reads of the global monotonic clock in the models and event-store libraries.

Default test fixtures now keep separate clocks. Regression tests independently
check late relay replies, final tool-send expiry and saved approval outcomes at
the decision deadline. Dispatch receipt handling is separated without changing
production deadlines or refusals.
