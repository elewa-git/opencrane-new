# Secondary bootstrap qualification (#12)

The earlier rounds below are historical. The latest source and live results are
recorded under [requalification on main](#requalification-on-main).

Date: 4 October 2026. Source: review-approved `a3ef79c`, plus the secondary-only
bootstrap override and runnable journey in this change. Rebase onto `origin/main`
completed without conflicts; its head was already the branch's base `39fe9da`.
Review pass 2 was LAND at `a3ef79c`, as supplied by the owner.

Environment: freshly claimed secondary stack `2`, disposable PostgreSQL, NATS,
OpenFGA, MinIO, Kubernetes namespace and secondary Zitadel CI identities. The
owner stack was not operated. Only the local stub model was configured; no paid
model calls were made. The installation command's token output stayed in memory
and is represented as `[REDACTED]` in evidence.

## First attempt

- PASS: secondary `up.sh --fresh` with `DEV_OWNER_BOOTSTRAP=0` skipped the dev
  owner and automatic member-seeding journey. Membership history was empty.
- PASS: `npm run bootstrap-token -w apps/server` generated the installation
  credential; its private file held the hash rather than the token.
- PASS: the real secondary CI owner signed in through Zitadel and claimed in
  Chromium at 1280px. HTTP 201 produced the successful owner screen; PostgreSQL
  bound that CI subject to the joined `bootstrap-owner` with role `owner`.
- PASS: claim screens fit 1280px and 390px. Screenshots contain no token:
  [signed out](signin-390.png), [claim form](claim-390.png) and
  [claim accepted](claimed-390.png). Corresponding 1280px images are alongside them.
- FAIL: OpenFGA owner checks and event-handler reads timed out. Its PostgreSQL
  reads could not complete, so owner permission convergence and chat did not pass.
- NOT RUN: stub chat, token reuse and second-user refusals on this attempt.
- FAIL then PASS: normal teardown could not reach the Kubernetes API through
  its load balancer. `down.sh --id 2` completed with a task-local kubectl wrapper
  using the directly reachable API. The secondary directory and namespaces were
  removed. The wrapper changed no owner or host configuration.

Read-only diagnosis found Docker's bridge forwarding chains retained rules only
for `upload-ci0`, with the existing Docker and k3d bridge rules missing. Shared
host networking was not changed. The orchestrator restored forwarding before the
successful resumed run below; this task ran no network repair.

## Checks before forwarding was restored

- PASS: repository lint, all-workspace typecheck and `check:events` (83 types).
- PASS: web production build and all 56 web tests in 11 files. Existing bundle,
  CSS and noVNC warnings remain.
- FAIL: root `npm test -- --maxWorkers=2` with
  `PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres` hit service
  timeouts in several integration files during the networking fault. It was
  stopped after these failures; this is not a completed or passing suite.
- NOT RUN: a successful complete root rerun and completed live qualification.

## Resumed live qualification

Date: 4 October 2026, 06:03–06:07 UTC. Source: `a3ef79c5d377a666b41791f261c083cad57c721a`
plus the secondary override and journey in this change. `claim.sh` allocated id
`2`; `DEV_STACK_ID=2`,
`ZITADEL_KEY_FILE=/home/jente/dev/opencrane-new/.keys/.zitadel-key` and
`DEV_OWNER_BOOTSTRAP=0` were set. Both installations used `up.sh --id 2 --fresh`.
The owner stack and host networking settings were untouched.

- PASS: fresh installation had no membership history. Real Zitadel owner sign-in
  and claim returned HTTP 201 and `bootstrap-owner`. PostgreSQL bound the CI
  subject to that joined owner; OpenFGA granted owner access.
- PASS: Chromium chat at 1280px streamed `Hello from your computer.` through the
  stub model and retained the completed reply after reload. Stop retained partial
  text after reload. First token: 15,312 ms; completion: 16,681 ms.
- PASS: the same token returned HTTP 409, `token_used`; the input was cleared.
  A different signed-in CI user returned HTTP 409, `owner_exists`. There was
  exactly one membership event: `silo.owner_bootstrapped` by the claimant.
- PASS: another fresh installation on the same secondary slot retained only the
  installation token hash. The second user joined as an ordinary member through
  an invitation event and `/members/join`. Their claim returned HTTP 409,
  `members_exist`; the input was cleared. History contained only `member.invited`
  and `member.joined`, with no ownership event.
- PASS: claim and refusal screenshots fit 1280px and 390px. Stub chat was
  exercised at 1280px and captured at both widths. See [chat](stub-chat-1280.png),
  [token reuse](token-used-390.png), [owner exists](owner-exists-390.png) and
  [members exist](members-exist-390.png). Corresponding widths are alongside them.
- PASS: `down.sh --id 2` removed the secondary stack. Follow-up checks found no
  secondary directory, Compose containers or computer/gateway namespaces.

Safe artefacts: [startup](startup.txt), [journey](journey.txt) and
[image inventory, including the computer image digest](images.json).
Installation token output is redacted; generated credentials were never committed.

## Resumed source checks

- FAIL: full root suite with the exact command below and unchanged defaults:
  76 files passed, one failed, three skipped; 1,365 tests passed, one failed,
  14 skipped, in 1,016.89 seconds. The failed live-view test expected its desktop
  WebSocket to stay open after bounded slow authority reads, but it was closed
  ([full result](root-tests.txt)).
- FAIL: the same test in isolation with two workers returned HTTP 403 instead of
  200 during admission ([focused result](live-view-test.txt)). This is an assertion
  failure, not the runner's default timeout. No authority deadline or assertion
  was changed, and a passing root suite is not claimed.
- PASS: `check:events` reports 83 matching event types. All 56 web tests passed
  in 11 files with `npm test -w apps/web -- --watch=false`.
- PASS: final repository `npm run lint` and `npm run typecheck` across every
  workspace. Lint includes dependency direction, unused code, Markdown, links
  and fixture checks.
- PASS: `npm run build -w apps/web`. Existing bundle/CSS budget and noVNC
  CommonJS warnings remain.
- NOT RUN: the 14 existing opt-in root tests skipped by their live/provider flags.
  The focused run's additional ten skips were cases deselected by its name filter.

Safe check logs: [lint](lint.txt), [typecheck](typecheck.txt),
[events](events.txt), [web tests](web-tests.txt) and [web build](web-build.txt).

The live bootstrap journey passed on fresh local installations. Source readiness
was blocked by the root-suite live-view failure on that source. The later
[admission repair receipt](../bootstrap-token-evidence.md#admission-read-scheduling-repair)
records the fix, rebase and passing source checks.

```sh
PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres npm test -- --maxWorkers=2
PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres npm test -- apps/server/test/live-view.test.ts --maxWorkers=2 -t 'admits bounded slow authority reads'
```

## Repeat

Claim a secondary stack only, then run:

```sh
set -e
until stack_id=$(infra/dev-stack/claim.sh); do sleep 60; done
export DEV_STACK_ID="$stack_id"
export ZITADEL_KEY_FILE=/home/jente/dev/opencrane-new/.keys/.zitadel-key
export DEV_OWNER_BOOTSTRAP=0
trap 'infra/dev-stack/down.sh --id "$DEV_STACK_ID"' EXIT
infra/dev-stack/up.sh --fresh
node --experimental-strip-types infra/dev-stack/bootstrap-journey.ts
```

The journey captures the install command's sole token output in memory, signs in
through real Zitadel, claims at 1280px, checks the owner projection and OpenFGA,
runs browser chat through the stub, and refuses reuse with `token_used`. A different
user receives `owner_exists` after that claim. To prove `members_exist`, it starts
another fresh installation on the same secondary slot, retains only the private
token hash, and admits the second CI user as an ordinary member through invitation
and the shipped join command. That member's claim must append no ownership event.
Both phases finish with `down.sh --id "$DEV_STACK_ID"` in the journey's `finally`;
startup failures must also be followed by that teardown command.

## Requalification on main

### Rebase onto live-view lease checks (#128)

The `libs/event-store/README.md` conflict keeps #128's explanation of transient
read failures and lease behaviour, alongside bootstrap's category-wide sequence
check for a fresh silo. The `apps/server/src/computers/view-access.ts` conflict
keeps bootstrap's parallel authority reads and bootstrap-event support, while
preserving #128's explicit-denial and unavailable-result paths. Recognised
transient store errors still become unavailable checks, so a late or unavailable
check cannot revoke a valid viewer lease. `CHANGELOG.md`, `ledger.md` and
`benchmarks.jsonl` retain entries from both sides.

Date: 4 October 2026. Application source:
`b74a97b5c47cd136a4b7953ca1f98ae8f8fb3531`, rebased onto `origin/main`
`65364a03b59babb3cacddd24978732edca831e5f` (#111). The rebase completed
without conflicts. Before qualification, the working tree was clean and neither
rebase state directory existed. Independent review pass 3 (astra) found no
blockers, as supplied by the owner; no additional review pass was started.

Bootstrap-event support remains in `libs/models` beside main's exact-subject
authority reads and fences. No authority implementation was duplicated, and no
application code, assertion or deadline was changed during this requalification.

Environment: this worktree, Node 22.23.3, clean `npm ci`, PostgreSQL at
`127.0.0.1:55432`, disposable service fixtures and a busy shared host.

| Source check | Result | Seconds | Evidence |
| --- | --- | --- | --- |
| `npm run lint` | PASS | 232.89 | [Log](requalified-lint.txt) |
| `npm run typecheck` | PASS | 170.40 | [Log](requalified-typecheck.txt) |
| `npm run check:events` | PASS, 86 types | 1.20 | [Log](requalified-events.txt) |
| `npm test -w apps/web -- --watch=false` | PASS, 60 tests / 11 files | 28.12 | [Log](requalified-web-tests.txt) |
| `npm run build -w apps/web` | PASS | 19.14 | [Log](requalified-web-build.txt) |

The first complete root run used
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres npm test -- --maxWorkers=2`.
It was **FAIL**: 1,404 tests passed, two failed and 14 were skipped; 80 files
passed, two failed and three were skipped, in 1,457.25 runner seconds. The losing
parallel approval retry returned 503 instead of 403; bridge replay timed out
waiting for its second report. [Complete result](requalified-root-tests.txt).

Both failed cases then passed in isolation with the same PostgreSQL URL,
`--maxWorkers=2` and unchanged timeouts: [approval retry](requalified-approval-focused.txt)
(18.02 command seconds) and [bridge replay](requalified-bridge-focused.txt)
(8.70 command seconds). These focused passes do not turn the failed full run
into a PASS.

The second full-suite attempt was **PARTIAL**: it was stopped with SIGINT after
the forged-restart case failed during gateway fixture startup (`Gateway stopped`),
before its refusal assertion ran. Exit 130; 930.06 command seconds. It is not a
completed or passing suite. [Failure excerpt](requalified-root-tests-rerun.txt).
That case then passed twice in isolation, again without code or deadline changes:
[first run](requalified-gateway-focused-1.txt) (19.49 command seconds) and
[second run](requalified-gateway-focused-2.txt) (16.43 command seconds). The
underlying startup error was not reproduced or repaired.

The subsequent complete root rerun was **PASS**: 82 files passed and three were
skipped; 1,406 tests passed and 14 were skipped, in 1,501.04 runner seconds
(1,504.52 command seconds). It used the same PostgreSQL URL, `--maxWorkers=2`
and `--reporter=verbose`; default test timeouts and application deadlines were
unchanged. [Final result](requalified-root-tests-final.txt). All earlier failing
cases passed in this complete run.

The 14 existing opt-in conditions remain **NOT RUN**. The focused runs' extra
skips are cases deselected by their name filters, not additional full-suite gaps.

### First fresh attempt after the rebase

Secondary stack `1`, 12:29–12:32 UTC. **FAIL** overall: fresh startup and the
real Zitadel owner claim passed, including the identity binding and OpenFGA owner
permission. The combined chat/upload step stopped at
`Native PDF viewer did not render its first page`; token reuse and second-user
refusals were **NOT RUN** on this attempt. `down.sh --id 1` completed and removed
the secondary directory.

The bootstrap fixture still launched Chromium's headless shell, which cannot
render the native PDF preview added to the shared chat journey by uploads #79.
Its first browser launch now uses the full `chromium` channel, matching
`browser-signin.ts`. This is the only fixture-code change after the source gates;
application code, assertions and deadlines remain unchanged.

Evidence: [startup](requalified-startup-attempt1.txt),
[journey](requalified-journey-attempt1.txt), [safe diagnostic](requalified-pdf-failure.txt),
[teardown](requalified-teardown-attempt1.txt) and [run metadata](requalified-live-attempt1.json).

### Corrected fresh secondary qualification

**PASS**, 12:51–12:58 UTC, secondary stack `1`. Application source was the
same `b74a97b`; the fixture included the full-Chromium selection above. The
claim loop waited while both secondary slots belonged to other worktrees.
`DEV_STACK_ID=1`,
`ZITADEL_KEY_FILE=/home/jente/dev/opencrane-new/.keys/.zitadel-key` and
`DEV_OWNER_BOOTSTRAP=0` were set. Both installations used `up.sh --fresh` on
that claimed slot. Only the local stub model was configured. The owner stack and
host networking were not operated or changed.

- PASS: the fresh silo had no membership history. Installation printed one token,
  held only in memory; its private file contained only the hash and expiry.
- PASS: real Zitadel sign-in and claim returned HTTP 201. The CI subject was bound
  to the sole joined `bootstrap-owner`, with role `owner` and OpenFGA owner access.
- PASS: Chromium chat at 1280px streamed `Hello from your computer.`, retained the
  completed reply after reload, and retained Stop's partial reply after reload.
  First token: **15,776 ms**; completion: **17,586 ms**.
- PASS: the inherited upload journey recovered one deliberately lost successful
  response without a duplicate file, rendered the native PDF preview, answered
  Willow-47 through the stub after MarkItDown conversion, and refused EICAR,
  forbidden types and oversized files. PDF, text and image previews passed.
- PASS: the same token returned HTTP 409, `token_used`, and the input was cleared.
  Another signed-in CI user returned HTTP 409, `owner_exists`. History contained
  exactly one membership event, `silo.owner_bootstrapped`, by the claimant.
- PASS: another fresh installation on the same slot retained only the token hash.
  The second CI user joined as an ordinary member through invitation and the
  shipped `/members/join` command. Their claim returned HTTP 409, `members_exist`,
  and cleared the input. Membership history contained only `member.invited` and
  `member.joined`; the refusal appended no ownership event.
- PASS: claim and refusal screens fitted 1280px and 390px. Chat interaction ran
  at 1280px and was captured at both widths after the upload checks. Current
  [owner](claimed-390.png), [stub chat with PDF answer](stub-chat-1280.png),
  [token reuse](token-used-390.png) and [members refusal](members-exist-390.png)
  screenshots replace the earlier snapshots. No screenshot contains a token.
- PASS: `down.sh --id 1` ran in the journey's `finally`. Follow-up checks found no
  secondary directory, Compose containers or computer/gateway namespaces.

Evidence: [startup](requalified-startup.txt), [complete journey](requalified-journey.txt),
[teardown](requalified-teardown.txt), [run metadata](requalified-live.json) and
[image inventory with computer digest](images.json). Startup took 88.60 command
seconds; the complete journey, including its second fresh installation and
teardown, took 303.64 command seconds.

Source readiness and the requested fresh secondary qualification are **PASS**.
The earlier failed and partial attempts remain recorded above. The 14 opt-in root
conditions and production installation remain **NOT RUN**; no paid provider was used.

## Mixed denial and unavailability correction

Date: 4 October 2026. Source: rebased `2af7a03` plus the correction in this
commit; main `d46928d` (P4-1 groups, #137). Environment: this worktree on
Linux, Node 22.23.3, PostgreSQL control database at port 55432 and disposable
service fixtures. This is source verification, not a fresh installation.

The rebase completed. Main is an ancestor of this branch; changelog entries,
ledger rows and benchmark records from both sides were retained. Live-view
checks retain parallel authority reads, group desktop grants and their fences,
bootstrap-event support and transient-store failure classification. P4-1's
receipt-aware desktop batch replaces the earlier direct desktop check.

An unavailable desktop result previously rejected the parallel read before a
conversation denial could be evaluated. The viewer stayed open until its lease
expired. All reads now settle before a decision: explicit denial first,
unavailable next, allowed last. A failed read cannot renew the lease.

- FAIL then PASS: the WebSocket regression covers conversation denial beside
  desktop unavailability and desktop denial beside conversation unavailability,
  with either response arriving first. Before the fix, both conversation-denial
  cases closed only after 1,445–1,478 ms. After the fix, all four cases close
  with `access_changed` before the unchanged 1,000 ms assertion.
- PASS: repository lint, all-workspace typecheck and event catalogue (86 types).
- PASS: web tests, 11 files / 60 tests; web production build. Existing size and
  noVNC module warnings remain.
- PASS: the three live-view files and all three bootstrap files, 6 files /
  55 tests, with the supplied `PG_TEST_URL` and `--maxWorkers=2`.
- PASS: full root suite with the supplied `PG_TEST_URL`, `--maxWorkers=2`
  and unchanged timeouts: 88 files / 1,475 tests passed, 4 files / 15 tests
  skipped, in 1,343.53 seconds. Integer load average was 9 before starting.
- NOT RUN: the 15 existing opt-in root conditions, a new fresh-install
  journey or paid-provider qualification.

[Regression, focused and root logs](denial-priority-tests.txt) retain the red/green
proof and final suite result. Gate logs are `/tmp/bootstrap-{lint,typecheck,events,web-tests,web-build}.log`;
the full-suite log is `/tmp/bootstrap-root-tests.log` on this builder host.
