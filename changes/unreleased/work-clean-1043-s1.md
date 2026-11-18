Access deadline tests can control time through an injected event-store clock.
Production keeps the same real timers and deadline lengths. The event store,
seven access-check paths and their fixtures share the selected clock.

Deadline tests now prove each final-send, authority and queue-entry guard
independently, including allowance at 1,999 ms and refusal at 2,000 ms.
