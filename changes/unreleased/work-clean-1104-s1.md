Routine ownership checks refuse slow database reads without permanently cancelling a
holder whose PostgreSQL session still holds its lock. Confirmed session failures,
shutdown and release still cancel it. Release tests use the real lock and probes,
control fixture clocks, prove the final refusal point and report early dispatch
failures with their phase before waiting for a handler.
Leadership diagnostics share the log-capture helper and exclude private error text.
