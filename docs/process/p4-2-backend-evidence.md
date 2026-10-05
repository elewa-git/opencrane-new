# P4-2 backend source evidence

Issue [#84](https://github.com/elewa-git/opencrane-new/issues/84), draft
[#156](https://github.com/elewa-git/opencrane-new/pull/156), decision D04.
Qualification date: 2026-10-05 (UTC). Source: rebased `work/p4-2-ownership`,
base `f0dd5b9`, plus the fixes committed with this receipt.

## Confirmed test seams

Authenticated HTTP with real NATS and disposable PostgreSQL/OpenFGA; public seed
and claim reactions, projection runner, member feed, process startup and replay.
Normal test fixtures use the supplied PostgreSQL control URL. Live journeys use a
secondary stack obtained through `infra/dev-stack/claim.sh`. The owner stack and
Docker daemon/network configuration are untouched. Checks run under `nice -n 10`.

## Regression proof

- Post-seed invitation: **PASS** red/green. The first runner test threw
  `Owner changes require the ownership stream`. It now proceeds and replays;
  reinvitations preserve an active member's identity and role.
- Seed contention: **PASS** red/green. A real member demotion before the fenced
  append originally rejected startup seeding. A fresh scan now retries and seeds
  only the remaining owner. Attempts stop after five, with ten-second scan bounds.
- Authority conflict: **PASS** red/green. Watched membership changed before append
  originally returned 503; it now returns 409 with `concurrent_change`.
- Receipt read: **PASS** red/green. Advancing the clock past the command fence after
  a successful append originally returned 503; its separate read bound returns 200.
- Plain Member transfer, claim-to-seed, startup failure survival and delayed owner
  IAM delivery are covered by the focused suites. Results are recorded below.

## Changes and limits

IAM member jobs retain their original subject keys. The unrelated Chromium test
change is removed from this PR. Audit authority changes retain main's 403 response.
Legacy member role interpretation is shared, and status reads have a named access
path. Dev fixtures invite Admins and skip active members; owner bootstrap refuses
to run after seeding and repeat startup skips it.

P4-3 must fence a successor's active membership at append time and add a
removal/transfer race test. Today's fence checks before append; a future removal
could arrive in the gap. No removal command exists in production today.

## Commands and results

Safe local logs: `/tmp/p4-2-*.log` on the builder host. These results report only
checks run for this task. Full root execution waits for integer host load below 16
and uses two workers; it does not overlap a live-view qualification batch.

| Gate | Result | Evidence |
| --- | --- | --- |
| Focused suites | PASS | Requested files passed across focused runs; final ownership HTTP 15/15; seed/process rerun 12/12 |
| `lint` | PASS | All checks; seven existing code warnings, no errors; final changed-code lint also passed |
| `typecheck` | PASS | All workspaces |
| `check:events` | PASS | 89 registry/catalogue event types agree |
| First complete root | FAIL | 1,591 passed / 3 failed / 15 skipped; 97 passed / 3 failed / 4 skipped files; 1,594.33 seconds; start load 15.09 |
| Final complete root | FAIL | 1,593 passed / 1 failed / 15 skipped; 99 passed / 1 failed / 4 skipped files; 1,368.29 seconds; start load 11.27 |
| Secondary FRESH journey | FAIL | Stack 2; browser upload transport `net::ERR_FAILED`, after membership assertions |
| Secondary REPEAT journey | FAIL | Same stack; browser upload transport `ERR_ABORTED`/`ERR_FAILED`, after active-member checks |

The complete root failures were:

- `approvals.test.ts`: step-up refusal returned 403 where 428 was expected.
- Restored `integrations.test.ts`: the protected-discovery message count was zero
  immediately after Check status, where one was expected.
- `gateway.test.ts`: daily-ceiling recovery returned 403 where 402 was expected.

The focused rerun selected six cases from those three files: **PASS**, six passed
and 122 skipped, in 60.52 seconds, without code changes. This does not turn the
first complete root FAIL into a PASS. The second complete run started at load
11.27 and failed a different gateway cap case: daily 1 / monthly 2,000 cents
returned `[200,402,402,402,402,403,402,402]`, where all seven refused calls were
expected to return 402. Both daily/monthly cap cases then passed alone: two passed
and 79 skipped, in 23.99 seconds, without code changes. The complete root gate
remains **FAIL**. Complete runs and focused reruns do not overlap.

The first focused run had 109 passing tests and one invalid new retry-bound
fixture. Its competing event was corrected to carry its own team id; both seed
tests and all ten process tests then passed. The final ownership HTTP run passed
all 15 tests, including audit's 403 response during an authority change.

The initial FRESH invocation used an extra `nice` wrapper and failed when the
stack's web priority adjustment attempted to raise priority. That attempt was
cleaned up, including its unrecorded web child. The requested commands were then
run directly: `up.sh --fresh`, followed by `up.sh`, with the supplied Zitadel key
path and an EXIT trap calling `down.sh --id`. Both reached the browser upload
step and failed there; neither whole journey is a PASS. Retained private logs have
no member-worker, dispatcher or server warnings/errors. CPU pressure was present;
its causal role in the transport failures is unproven.

A read during REPEAT startup found the seeded owner joined as Owner, the fixture
administrator joined as Admin and the fixture member joined as Member. Members
and groups both reached checkpoint 139; each fixture identity had one invitation.
The end-of-REPEAT query was NOT RUN successfully: teardown removed the settings
before the corrected capture command connected. The EXIT trap released stack 2.
Safe state read: `/tmp/p4-2-live-membership.json`; command logs:
`/tmp/p4-2-live-fresh-final.log`, `/tmp/p4-2-live-repeat-final.log` and
`/tmp/p4-2-root.log` and `/tmp/p4-2-root-final.log`. Dependency failure details
remain in private host logs.

The branch exceeds the roughly 1,500-line target because it retains the requested
public HTTP, contention, claim, process-startup and replay proofs. The unrelated
Chromium change and ordering-key change are removed rather than bundled into it.
The Chromium patch is retained outside this feature at
`/tmp/p4-2-integrations-separate.patch` for separate work.

```sh
nice -n 10 npm run lint
nice -n 10 npm run typecheck
nice -n 10 npm run check:events
PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres nice -n 10 npm test -- --maxWorkers=2
```

## Remaining qualification

Backend source gates: **PARTIAL**, because the complete root gate is **FAIL**.
Overall feature: **PARTIAL**. Ownership desktop/390px screens are **NOT RUN** and
belong to the later UI implementation. No managed-cluster, HA or backup claim is
made. The handler manifest change requires the documented controlled subscription
rebuild; its live upgrade qualification is **NOT RUN**.
