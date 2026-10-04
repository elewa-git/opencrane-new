# Secondary bootstrap qualification (#12)

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
stack_id=$(infra/dev-stack/claim.sh) || exit 1
export DEV_STACK_ID="$stack_id"
export ZITADEL_KEY_FILE=/home/jente/dev/opencrane-new/.keys/.zitadel-key
export DEV_OWNER_BOOTSTRAP=0
infra/dev-stack/up.sh --id "$DEV_STACK_ID" --fresh
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
