- Approved HTTPS tool retries recover after a refused budget admission without
  sending twice. Repeated unrelated events no longer stop the budget writer;
  every attempt keeps the original permission checks and two-second deadline.
- An expired budget write no longer disables later spending operations when nothing
  was sent to the event store. Lost write replies still stop the writer safely.
