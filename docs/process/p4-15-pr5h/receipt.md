# Private memory host runner checks

Part of #97. Scope: the first host probe and the fixed image entry only.

The test-first commit is `455dc5210`. Before implementation, the host and request
suites failed because their modules were absent. The saved-result regression and
real container entry also failed because the entry was absent (46 existing tests
passed). These were expected failures, not qualification results.

The runner reads host settings itself and accepts no observation or executable from
its caller. It refuses unsafe or unreadable settings and malformed requests. A safe
fixture passes only the host probe; all eleven journey names still refuse. The saved
result test starts with collector PASS, invokes the real partial entry and confirms
that the saved result becomes FAIL. Its earlier PASS uses simulated Docker responses.

## Own checks

All test and static commands ran under `nice -n 10`. Tests used the supplied
`PG_TEST_URL`. No root test suite ran.

| Check | Result |
| --- | --- |
| `npm ci` and tool symlinks | PASS |
| Explicit collector Vitest config | PASS: 174 tests |
| Changed tests, repeated with the explicit config | PASS: 130 tests twice, including seven added format-boundary cases |
| Real image entry and supervisor EOF, timeout, overflow and group cleanup | PASS: disposable container fixtures only |
| `libs/events/test/security-rules.test.ts` | PASS: 460 tests, unchanged |
| `tsc -p scripts/private-memory-qualification/tsconfig.json` | PASS |
| `npm run lint` | PASS: complete command after fixture typing fixes |
| `npm run typecheck` | PASS |
| `npm run check:events` | PASS: 157 event types |
| `npm run lint:unused` (Knip) and `npm run lint:changelog` | PASS |

The first implementation run found a test defect: the final `docker top` check
omitted its required PID column. After that correction, both runs above passed.
The earlier Knip run found the new entry unlisted; its explicit entry is now recorded.
Initial code lint found unsafe type assertions in fixtures. A focused check also
found an unsafe matcher type. Typed references, a plain copy and explicit expected
results replaced them. Focused lint passed, and each affected test ran twice again.
Fixture containers were removed with their volumes. No deployment, supervisor,
authority-test or event-schema change was needed.

## Outstanding live work

NOT RUN: all nine live journeys: private turns, native recall, requester isolation,
session isolation, invalidation, unrelated activity, Stop/reconnect, replacement/reload
and persistence. Both complete qualifications (P4-14 and P4-15), pinned native launch,
volatile replies and immutable deployment qualification remain outstanding.

The later journey remains held until these pass. Other process namespaces and guest
kernels need their own observations, including server, bridge and proxy buffers.
Copied receipts, human UI checks and protocol PASS cannot replace live assertions.
Fixtures are not qualification. No stack, bootstrap, model call or host-setting change
was made. Production admission stays disabled. Live collection belongs to
`work/p4-15-pr5i`.
