# Competing approval retry diagnosis

Own checks on 25 October 2026, after rebasing onto `11ed0475a`. The failing tests
were committed as `3fb8584f1` before the implementation in `0c0b02438`.
The test boundary is the real HTTP gateway and the saved event log. No owner stack,
real model or secondary development stack is used.

## Reproduced ordering

The earlier 53/60 reports record response statuses but no request ids or saved
approval rows. They cannot establish the individual histories of those seven
failures. The new tests reproduce two 403s with a controlled ordering and record
which call consumed consent. This is a reproducible cause, not an invented trace
of the historical runs.

Both calls read `approval.retry_requested` at sequence 49. A test barrier holds
each `approval.used` append until both calls have reached it. NATS then accepts
one conditional append and refuses the other. The tests add 300 ms to the clock
at each full member-history read; real NATS, PostgreSQL, OpenFGA and gateway
fixtures still run. The final regression advances only this controlled clock;
separate load repetitions use real time. No production deadline is extended.

The failing budget-admission case recorded this sequence:

| Step | Request A: `cdc1b88a-267a-4fc8-b733-3d8f9c527380` | Request B: `d83e4bc3-8b8e-47a2-8e03-d18986082bd8` |
| --- | --- | --- |
| Read restored consent | Approved at sequence 49 | Approved at sequence 49 |
| Consume consent | `approval.used` appended | Conditional conflict; no use saved |
| Save decision | `allow`, `approval_used` | `ask`, stale `approval_approved` |
| Continue dispatch | Rereads the same authority history | Decision HTTP response is 403; no dispatch start |
| Read history again | Remaining time falls through 634, 228 and -149 ms | Already refused |
| Finish | Dispatch HTTP response is 403 at `budget_admission`, `access_deadline_expired` | Still refused |

The saved-start case reproduced the same ordering with request
`19cd5b08-59f5-4c33-8e3b-aa28ec20f3f3` consuming consent and
`e1846140-1cac-44f1-8ff7-d0b1fa941dbb` losing the conditional append.
The consumer exhausted its budget-admission deadline; the competing decision
reported stale `approval_approved`. Neither refusal was a second use of consent.

The expiry was the immediate refusal, not the root cause. Before the fix,
`currentAuthority` fetched the same immutable rows at the same original event
position for initial access, budget admission checks, MCP admission and final
access. A normal traced successful call performed six such authority reads.
Under the controlled read cost, repeated work consumed the shared two seconds
while all grants, the turn and IAM permissions remained valid.

The original test helper also selected the first decision appended during both
requests. It could therefore attach A's saved evidence to B's response. It now
matches each decision's call id to that request before reading dispatch evidence.

## Correction

One MCP invocation now keeps the immutable history reads at its original event
position. Later checks reuse only those rows. Live IAM receipts and permissions
are still read each time, in their existing order. Checks for later access, turn,
policy and memory changes still run. A new request gets a new reader. Read errors
remain errors. Neither approval expiry nor the original send deadline changes.

After a conditional approval-use refusal, the decision reads the saved approval
state within the original deadline. It reports `approval_outcome_unknown` after
the competing use, without granting a permit. The successful caller keeps its
original live permit. Nothing resends, and later invocations cannot use that permit.

## Failing-first evidence

- **FAIL, expected:** both synchronised races returned stale `approval_approved`
  for the competing request instead of the saved `approval_outcome_unknown`.
- **FAIL, expected:** both slow-history races returned `[403, 403]` rather than
  `[200, 403]`. Their trace identifies both consent-use attempts and the only
  successful append, followed by the consumer's deadline refusal.
- **PASS:** all four unchanged assertions passed after implementation. Each race
  now has one 200, one 403, one upstream send, two consent uses including the
  initial unsent attempt, one budget admission and zero held or settled cents.
  Subsequent calls still send nothing.

An initial repeated probe combined actual elapsed time and the injected clock
cost. It completed 20 cases: 16 passed and four returned two 403s; the run was then
stopped. The trace shows that the immutable rows were no longer reread, but those
requests still exhausted their original deadline. Those results are **FAIL** for
that combined workload. They are not attributed to a host-load cause or relabelled
as random failures. A request that exceeds its access period must still refuse.

The final tests separate two questions: the controlled clock tests whether repeated
history work exhausts the allowance, and the real clock measures the HTTP race.
Both controlled-clock tests were rerun against the production sources from the
test-first commit and still failed with `[403, 403]`. No expected result was relaxed.
A complete HTTP file run then passed 22 cases and failed the evidence helper in
its 2100 ms history-expiry case. That refusal happens before the body is read,
so its saved decision has no call id. The helper now uses that response's own
request id for early refusals. It never falls back to another call's decision.
All three history-budget cases then passed with their original assertions.

The test callback signature was also corrected after typecheck rejected its optional
second parameter; the one-argument wrappers now match Vitest's table contract.

Local logs: `/tmp/budget-approval-fix/red.log`, `red-trace.log`, `green.log`,
`mixed-clock-load.log` and `deterministic-red.log`.
Only fixture ids, fixed labels and timings appear in the trace above.
Fresh-install qualification: **NOT RUN**.
