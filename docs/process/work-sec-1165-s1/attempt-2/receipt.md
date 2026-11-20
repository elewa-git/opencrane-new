# Second fresh-stack attempt

Journey: FAIL at startup. CORE: NOT RUN. Teardown: PASS.

Source: `1e83bf257`. Claimed secondary slot 1 after the recorded free-slot and
five-minute load checks. PostgreSQL database initialisation failed with
`Connection terminated unexpectedly`. The sanitised diagnostic was retained before
teardown. No browser journey or screenshot ran. `down.sh --id 1` exited 0.

A separate Docker fixture reproduced the inherited Unix-socket probe reporting ready too
early while PostgreSQL's temporary init server was running. Secondary
stacks now require TCP readiness. The regression test passed twice after that
change, including refusal during temporary initialisation and success after the
final server opened TCP. No retry or timeout was increased.

- [Outcome](outcome.json)
- [Startup console](startup.log)
- [Sanitised diagnostic](service-logs/failure.log)
- [Admission window](load-wait.jsonl)
