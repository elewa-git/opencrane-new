# P4-1 backend evidence

4 October 2026. Branch `work/p4-1-groups`, based on main
`f88c93458246fa38315e7d390320d3d2a0882145`. Source receipt; no stack was changed.
The final local commit identifies the tested source.

## Scope and contract

[Issue #83](https://github.com/elewa-git/opencrane-new/issues/83), parent
[#82](https://github.com/elewa-git/opencrane-new/issues/82). The owner's backend-only
instruction overrides the ticket's whole-screen requirement while Claude Design
prompt 4 is outstanding. No screen or visual qualification is claimed.

Groups reuse team events and `team#member`, assistant `acts_for` and resource
`use`. Membership, silo role, conversation participation and private memory remain
separate. D20 is the Phase 3 paying-group decision: group ids are payer ids,
personal defaults stay explicit, and shared work never substitutes another payer.
No money engine, dependency, direct tuple-write route or second change ledger.

The design's binding contract is [the groups HTTP interface](../api/groups.md).
The members worker also runs the groups projection from its own checkpoint, so
existing installations rebuild historical group events without a new stack unit.
PostgreSQL recovery uses `npm run replay -- groups --verify`; OpenFGA recovery
uses the existing `openfga` replay procedure with decisions and its worker stopped.
Replay loads no external-effect reactions.

## Verification receipt

Environment: existing PostgreSQL 17 at
`postgres://postgres:test@127.0.0.1:55432/postgres`, isolated test databases, the
repository's disposable NATS/OpenFGA fixtures and recording gateway upstream.
No fresh installation, paid call, host-network change or daemon setup.

| Claim | Command or seam | Result |
| --- | --- | --- |
| Commands and HTTP | `apps/server/test/groups.test.ts` | PASS: Owner/Admin, duplicate commands, one append, stream races, refused members/silos/Origin, strict request shapes, IdP read-only sources, change reconciliation |
| Content and IAM replay | Groups suite, existing replay tools | PASS: same group view and allowed/refused tuples after reconstruction |
| Exact authority subjects | `libs/models/test/authority.test.ts` | PASS: adapter seeded with 100,000 unrelated team events rejects wildcard reads; exact real NATS reads and real OpenFGA checks finish below one second |
| Group-derived live access | `apps/server/test/live-view.test.ts` | PASS: group desktop grant with separate participation; removal closes the socket within two seconds before IAM catches up; direct grants remain independent |
| Gateway admission and budgets | Group ceiling test plus real gateway regressions | PASS: silo removal, suspension before fence capture, distinct payer removal after allow audit, no refused call dispatched |
| Root typecheck | `npm run typecheck` | PASS across all workspaces |
| Event catalogue | `npm run check:events` | PASS: 85 event types |
| Root lint | `npm run lint` | PASS: code, dependency direction, unused code, Markdown, links and fixtures; eight non-blocking size warnings |
| Complete tests | `PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres npm test -- --maxWorkers=2` | PASS: 1,397 passed, 14 skipped; 78 files passed, three skipped |
| Fresh-install journey | Not run; owner forbids stack work | NOT RUN |
| Screens and desktop/390px comparison | Awaiting Claude Design prompt 4 | NOT RUN |

The large-history adapter test establishes that unrelated events are never read;
it is not a 100,000-event live NATS throughput benchmark. Source-ready and
fresh-install capability completion remain separate claims.

Independent review: two passes. Pass 1 found the computer/payer admission races
and an unrelated group dependency in desktop access; targeted regressions failed
before the fixes. Pass 2 verified the batched fixes and returned PASS with no
remaining code blockers, conditional on the required gates.

The complete gate run then exposed repeated history reads in model admission.
Admissions now share each exact history within the request, with the computer
fence captured before reading event-backed credentials. The slow-read,
suspension, grant-revocation and separately selected payer regressions pass.
The older paying-group fixture now includes active silo membership. The earlier
complete run failed the slow-read case and incomplete paying-group fixture plus
three fixture wall-clock timeouts; it is not used as a passing receipt. The final
optimisation was checked with these regressions after the two independent review
passes.

The next complete run exposed the desktop's bounded slow-read case. Its IAM
checks now use one exact OpenFGA batch for participation, desktop use and grant
receipts. Missing, failed or refused answers deny access. The existing admission
deadline and revocation lease are unchanged; slow reads, group removal and direct
grant independence pass together. This final adapter change is also after the
independent review passes and is covered by the final gates.

With the final backend, the complete run passed 1,396 tests and failed only the
existing integration-policy fixture at Vitest's five-second default. That case
passed in isolation. The default fixture test budget is now 30 seconds; explicit
service deadlines, revocation assertions and longer test-specific budgets remain
in place. The complete suite is rerun with the requested two workers.

The final input regression accepted a NUL name and then failed the real
PostgreSQL replay. Both the local command and `team.created` schema now reject it
before append; the refusal also verifies that the stream head stays unchanged.

The final backend passed all service cases in the complete run; the remaining
Chromium case reached PASS internally and hung awaiting Angular shutdown. Its
disposable fixture now tries SIGTERM, then reaps the child after one second if
needed. The same browser case passes with bounded cleanup, taking 162 seconds in
isolation. Its process budget is now five minutes for parallel load; individual
assertions retain their deadlines. Screens are unchanged.

The next complete run passed the Chromium case and 1,395 other tests, but the
existing audit browser fixture timed out waiting for its loading state. That
fixture passed in isolation on unchanged source. This failed run is recorded
separately; the complete gate is rerun without further source changes.

The final complete gate passed: 1,397 tests passed and 14 were skipped, with all
78 runnable test files passing. Lint, typecheck and the event catalogue check
also passed. Source-ready: PASS. Fresh-install capability qualification: NOT RUN.
