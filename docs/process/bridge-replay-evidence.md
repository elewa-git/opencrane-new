# P2-3 replay verification — 2 October 2026

Source: `work/bridge`, parent `b2ee4ce`. This receipt belongs to the commit
containing these fixes. Review pass 2 confirmed the earlier six fixes and found
three new blockers. The owner authorised one fix round followed by one focused
verification. This is that round; no new review cycle or landing is claimed.

## Reproductions

Each reproduction failed before its implementation changed.

| Finding | Red result | Fix and regression |
| --- | --- | --- |
| Completed-start replay | With Alice report 1 missing and Bob start 2/completion 3 committed, reconnect from 0 closed the socket instead of acknowledging all three reports. | Digest-verified duplicate starts of closed turns acknowledge without admission or a token. Alice report 4 still persists; Bob reports remain unique. Both completed lifecycle and missing lifecycle closure cases pass. A changed start digest is refused. |
| Old conversation history | Publishing original `conversation.created` bytes without mode to real NATS caused both PostgreSQL projection rebuilds to reject at checkpoint 0. | Read schema defaults missing mode to `agent_session`. Conversation and member rebuilds reach checkpoint 2 with the expected rows. A separate raw NATS assertion proves new commands store mode explicitly. |
| Old Alice/Bob journals | Alternating Alice/Bob reports without `previousSequence` closed the connector, inventing a gap. | Legacy reports are processed in global computer order and continuity uses that same scope. All four reports persist once and reconnect succeeds. Modern queues still acknowledge independently under pressure. |
| Permanent rejection recovery | A real gap closed with 1011 and the generic persistence-unavailable reason, allowing repeated reconnects. | A permanent refusal closes with 1008 and a safe reason. The watcher logs the computer id/reason and stops reconnecting that computer; the test observes more than three polling intervals and checks that private report text is absent from logs. |

The final crash-window assertion also caught an overly broad duplicate bypass
within this fix round: it skipped the missing terminal lifecycle closure. The
bypass now applies only to starts; replaying the terminal report closes the turn.

## Gates and limits

Every test command uses `PG_TEST_URL` for the separate PostgreSQL test instance
on port 55432. NATS fixtures and PostgreSQL databases are disposable. Kubernetes
credential delivery is stubbed only in the watcher rejection test. No dev-stack
process, database, namespace, ownership marker or deployment was changed.

The earlier [six-fix receipt](bridge-fixes-evidence.md) retains its historical
results; its pending second pass is superseded by this receipt.

| Gate | Result |
| --- | --- |
| `npm run lint` | PASS; five existing function-size warnings, no errors |
| `npm run typecheck` | PASS after explicit report return and ES2023-compatible test iteration corrections |
| `npm run check:events` | PASS; 73 event types |
| `PG_TEST_URL=… npm test` | PASS, 1,015 passed / 3 opt-in skipped; final run 140.14 seconds |
| `npm run build -w apps/web` | PASS; existing CSS size warning |
| `PG_TEST_URL=… npm run test -w apps/web -- --watch=false` | PASS; 41 tests |
| Focused independent verification | FAIL; findings 1 and 2 pass, finding 3 introduces the blocker below |

## Remaining blocker and owner decision

The focused verifier reproduced a new expiry regression with the actual watcher
and computer channel, a pending message, in-memory supporting adapters and a
150 ms credential. After 1.1 seconds there was only one connection and one
credential installation, plus an incorrect report-rejected log. No report was
rejected. The computer channel closes with 1008 on ordinary credential expiry;
the watcher now treats every 1008 as permanent and prevents reconnect until
watcher restart. Production credentials normally last 600 seconds.

The concrete follow-up is to stop reconnecting only when the connector has
recorded an actual permanent report refusal, using `connected.rejection`;
ordinary credential expiry must renew and reconnect. Add the expiry regression
before making that change. The owner authorised one fix round and one focused
verify, so this additional fix is **held for the owner**, not silently added
after verification. The source is **not ready to land** despite green gates.
No further independent review was run.

Fresh full-product installation, Kubernetes/Pod replacement, paid providers,
production image qualification and merge/CI on main are **NOT RUN** in this round.
The ordinary suite's opt-in Kubernetes and paid-provider tests remain disabled,
as required by the instruction not to touch the dev stack. No PostgreSQL test
is skipped. These results qualify source recovery, not the complete live journey.
