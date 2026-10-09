# Invitation renewal during acceptance

Date: 9 October 2026. Source: `4a2b4d64175e605fd31ac84c08c2df9c8aa40c8e`.
The branch was rebased onto `70b8af3fd4450e04e73f268108adaf482742eb7a`.
The rebase completed, main was confirmed as an ancestor and the working tree was clean.

The checks used local Linux and Node 22.23.3. Integration tests used disposable
NATS, OpenFGA and PostgreSQL 17 fixtures, with `PG_TEST_URL` set. This was not a
fresh installation of OpenCrane. Checks ran under `nice -n 10`; Vitest used
at most two workers. No dependencies were added.

## Failure before the fix

The tests were committed first in `91ef9dc6`. An admin renewed an Admin invitation
as a Member invitation after acceptance read the original invitation, but before
it read the member position used for the account check. Acceptance returned 200;
the new test expected 409. The three later renewal intervals already refused it.
The failing run is recorded in `/tmp/p4-3-round2-red.log`.

## Change

Acceptance now checks that the invitation stream has the position read at the
start of the request. It checks this after reading account records and before
starting the two-second access check. A renewed invitation returns
`unknown_invitation`. An unexplained change returns `concurrent_change`.
The conditional append still checks the captured position across `member-*`,
so a later renewal or competing join cannot save the old role.

The four renewal tests check saved events, refusal of the old invitation and
successful acceptance of the renewed Member invitation with no assistant request.
They also check that PostgreSQL records the renewed Member role.

## Check results

| Check | Expected result | Observed result | Status |
| --- | --- | --- | --- |
| Focused tests, including the four requested server suites | All tests pass | 246 tests passed in eight files | PASS |
| Changed tests repeated | All acceptance and account-read tests pass again | 184 tests passed in three files | PASS |
| Guard removals | Each removed guard makes its owning test fail | All 21 removals failed their owning tests; source restored | PASS |
| `npm run lint` | No lint errors | No errors; 14 existing warnings | PASS |
| `npm run typecheck` | All workspaces pass | All workspaces passed | PASS |
| `npm run check:events` | Registry and catalogue agree | 98 event types agree | PASS |
| `npx knip` | No unused-code errors | No errors | PASS |
| `npm run lint:changelog` | Branch release note is valid | Passed | PASS |

The focused run covered `main.test.ts`, `shutdown.test.ts`,
`organisation-check.test.ts`, `member-joined.test.ts`, `invitations.test.ts`,
`email-admission.test.ts` and `groups.test.ts` in `apps/server/test`, plus
`libs/event-store/test/history-checked.test.ts`. Its log is
`/tmp/p4-3-round2-tests-pass1.log`.
That run used `48b62309`. The final source above adds a test for the member-position
read deadline; its 17 account-read tests passed in
`/tmp/p4-3-round2-admission-final.log` before the repeated acceptance run.
The repeated run covered `member-joined.test.ts`, `invitations.test.ts` and
`email-admission.test.ts`; its log is `/tmp/p4-3-round2-tests-pass2.log`.

The guard checks removed one check at a time. They cover checkpoint validity,
projected and combined candidate limits, recent and candidate history limits,
silo and subject checks, conflicting account bindings, later events, all three
account-read deadlines, saved invitation ids, missing databases, both append
deadlines, joined principal kind and subject, and the new invitation-position
check. All source files matched the committed version afterwards. Logs are
`/tmp/p4-3-round2-mutations.log` and `/tmp/p4-3-round2-mutation-01.log` through
`/tmp/p4-3-round2-mutation-21.log`.

Other check logs are `/tmp/p4-3-round2-lint.log`,
`/tmp/p4-3-round2-typecheck-final.log`, `/tmp/p4-3-round2-events.log`,
`/tmp/p4-3-round2-knip.log` and `/tmp/p4-3-round2-changelog.log`.
Lint and server typecheck passed again after the final test change, in
`/tmp/p4-3-round2-lint-changed-final.log` and
`/tmp/p4-3-round2-typecheck-server-final.log`.

The first wider run found two invalid test fixtures and the first typecheck found
test typing errors. These were corrected before the final checks. A non-ASCII
invitation is refused by the event schema before it reaches the log; the test
checks that boundary. The additional ASCII check inside acceptance remains extra
protection. Current valid stored invitations cannot exercise that refusal branch.

## Conditions not tested

The full root suite was NOT RUN, as requested. Fresh-install sign-in and invitation
acceptance were NOT RUN. A further independent review was NOT RUN; this task fixes
the remaining finding from the second review. The PR stays a draft.
