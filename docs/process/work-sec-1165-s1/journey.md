# Fresh CORE journey

Journey on a fresh dev stack: PARTIAL

Current product source: `e151c407abc9a24b8d504b1886fd1b6b0efee14b`.
Source checks: PASS. Fresh CORE and the supplemental signed-out WebSocket check
on this corrected source: NOT RUN.

## Startup attempts

Two fresh attempts stopped before CORE. Both claimed secondary slot 1 only after
free-slot checks and a five-minute load window. Both were torn down successfully:

- [First attempt](attempt-1/receipt.md): the launcher had an absent credential path.
  Its path reference was corrected before the second attempt. The original
  diagnostic text was filtered out; its metadata and startup console remain.
- [Second attempt](attempt-2/receipt.md): PostgreSQL closed its initial connection.
  The sanitised failure diagnostic was copied before teardown. The secondary
  readiness probe now requires TCP. Its isolated regression test passed twice,
  including refusal during temporary initialisation and success after the final
  server opened TCP. No retry or timeout was increased.

After this correction, another task occupied a secondary slot. Load also exceeded
6. The [admission samples](qualification-wait.jsonl) record both conditions. The
remaining task budget could not fit the required five-minute admission window,
full CORE journey, evidence capture and teardown within the owner's 2.5-hour stop
limit. This task claimed no further stack.

## Outstanding live checks

- NOT RUN: fresh CORE on the corrected source at 1280 × 900 and 390 × 844 px.
- NOT RUN: signed-out POST and WebSocket checks against the fresh journey's actual
  conversations at both widths, with HTTP 403 and an unchanged event-store head.
- NOT RUN: new screenshots and service logs from a completed CORE run.

The prepared supplemental check uses fresh Playwright contexts with no application
cookies and no WebSocket ticket. It checks browser refusal and a direct HTTP
upgrade response, as well as the real NATS global head. Its execution is pending;
this receipt claims no result from it.

[Rework proof and source gates](rework.md) record the four review findings,
failing-first commits, independent mutations and successful source checks.
The [earlier journey](initial-journey.md) belongs to the previous product source;
it does not qualify the current changes. The PR remains a draft and cannot land
with this qualification outstanding.
