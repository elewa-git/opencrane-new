# P3-2 — Bound approval evidence

Receipt date: 3 October 2026. Original source: `2c70fc2`, stacked on
`b63234cb65548e6d839ae8a99241af5c2b0aea84` (P3-1). Environment: Linux, Node 22, disposable NATS and OpenFGA, isolated databases
under `PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`, real agentgateway,
recording credential-free upstream. The shared dev stack was not changed.

## Architecture

The event store holds the complete request and terminal states; PostgreSQL and
OpenFGA retain the existing replayable context projections. Reviewed safe scalar
fields generate an encrypted action ledger, never arbitrary model prose. Missing
review data, hidden fields, nested arguments and malformed JSON refuse. The original
upstream body retains its number lexemes. Request identity includes all bindings,
so retry cannot reopen an answered request. Each decision and consume command makes
one conditional append. Current checks and the authority fence precede consume;
decision audit and the final fence precede forwarding. Loss of an acknowledgement
can burn an approval but cannot cause a second upstream call.

The API uses the original requester, session-bound CSRF and exact Origin. Conditional
OIDC step-up binds the original session and approval, checks the same subject and
organisation, and accepts only verified, non-future `auth_time` within five minutes.
The 8g card restores from the server and keeps submitting, confirmed-safe retry and
unknown outcomes distinct. Terminal cards collapse permanently.

## Validation

| Check | Result / observed outcome |
| --- | --- |
| Clean `npm ci` | PASS; no new third-party dependency |
| `npm run lint` | PASS; code, dependency direction, unused code, Markdown, local links and fixture checks |
| `npm run typecheck` | PASS across all workspaces |
| `npm run check:events` | PASS; 76 event types agree |
| `npm test -- --maxWorkers=2` | PARTIAL invocation: 1,095 passed, one existing budget race failed under load, 11 skipped; isolated rerun below passed |
| Isolated gateway timing rerun | PASS; both last-reservation races and tool-mode/revocation case (3 tests), with the two-second limit unchanged |
| `APPROVAL_BROWSER=1` approval suite | PASS; 15 tests using real gateway/NATS/Postgres/OpenFGA plus Chromium |
| Final access-freshness regression | PASS; removal refuses review reads before OpenFGA catches up, alongside requester/step-up and renewed-token race checks |
| Lossless vectors and event/OIDC security suite | PASS; 344 tests |
| `npm run build -w apps/web` | PASS; existing bundle/style budget warnings remain warnings |
| `npm run test -w apps/web` | PASS; 8 files, 50 tests |

The full test invocation exited 1; it is not represented as a clean full-suite exit.
The one remaining failure was the existing eight-request budget race admitting zero
calls under the freshness deadline while other tests were active. Both budget races
and the revocation timing case passed when rerun alone. Earlier runs also exposed
schema validation/import mistakes, which were repaired and rechecked. No assertion
or deadline was weakened. Live k3d and paid-provider tests stayed gated off; the
browser test skipped by the root command ran separately with its flag enabled.

The approval suite asserts one upstream call across duplicate asks, two decisions,
two concurrent retries and gateway restart; zero calls for refusal cases. It covers
exact forwarded bytes, hidden/ambiguous fields, changed schema/profile/turn, revoked
rights, both fence positions, lost consume acknowledgement, unreadable review keys,
requester/admin substitution, session/Origin/CSRF and conditional step-up. Final
read-authorisation checks also refuse removed participants while OpenFGA lags. The OIDC
fixture separately proves missing/stale/future authentication, session swaps and a
different requester are refused. Browser evidence includes requested/reloaded and
terminal/reloaded cards, submitting, lost response, safe retry, keyboard focus,
44px controls and reduced motion. All effect counts are from the recording upstream.

Images: [requested desktop](../design/chat/comparison/p3-2/requested-1280.png),
[requested phone](../design/chat/comparison/p3-2/requested-390.png),
[used desktop](../design/chat/comparison/p3-2/used-1280.png),
[used phone](../design/chat/comparison/p3-2/used-390.png). Compared against the
[8g frame](../design/chat/wireframes/03-8g-ask-card.png); text wraps instead of
reproducing the reference's overlapping example. Account/profile disclosure is
explicit for the credential-free fixture. The browser serves the built app with the
real approval API; chat WebSocket continuation is outside this fixture.

Safe local logs: `/tmp/p3-2-{lint-done,types-done,test-final,timing-isolated,approvals-done,security,build-done,webtest-done,read-green,renewal}.log`.
Agentgateway SHA-256: `daca5cda76e8c5ab0c1a75912fecf2d6365095403f810db72029c49d14a37e7b`.
NATS binary SHA-256: `387ce54e7a0a249d877a579ed641d715bab047d7e061bfa42b4d07f6a0401341`.
OpenFGA image: `v1.21.0@sha256:2113c664a486b5da8d7a2cdab479e0d4e30639c80fd2c000540f645c1dbc1e55`.

## Review pass 1 fixes

Receipt date: 3 October 2026. Source: `228ac08`, based on `2c70fc2`. Same isolated fixture environment and `PG_TEST_URL` as above; no dev-stack
changes, rebase or push. These are source checks, not fresh-install qualification.

Both regressions were written and run before their fixes:

- Real NATS/API/gateway: each older-turn stop, completion and failure incorrectly
  cancelled the current requested approval (3 expected failures). With terminal
  events checked against the bound turn id, all 3 cases pass: unrelated events
  preserve requested and approved cards, while closing the bound turn cancels the
  card and refuses forwarding with zero upstream calls.
- Built app in Chromium: the new `stepUp=true`, 390px case failed on “Sign in again”
  at 40.796875px high. The link now has a 44px minimum width and height. The browser
  journey passes with width and height assertions for every button and link,
  including step-up, plus the existing desktop/mobile decision and reload checks.

Red/green logs: `/tmp/p3-2-r1-{turn,browser}-{red,green}.log`.

| Check | Result |
| --- | --- |
| `npm run lint` | PASS; 5 existing warnings, no errors |
| `npm run typecheck` | PASS across all workspaces |
| `npm run check:events` | PASS; 76 event types agree |
| `PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres npm test -- --maxWorkers=2` | PASS; 67 files passed, 2 skipped; 1,100 tests passed, 11 skipped; no timing failures to rerun |
| `npm run build -w apps/web` | PASS; existing bundle/style budget warnings |
| `npm run test -w apps/web -- --watch=false` | PASS; 8 files, 50 tests |
| Chromium approval journey with `APPROVAL_BROWSER=1` | PASS; 390px step-up plus 1280px/390px decision and reload cases |

The browser case skipped by the root run passed separately above. Gated live tests
remain unrun. Check logs: `/tmp/p3-2-r1-{lint,typecheck,events,test,build,web-tests}.log`.

## Rebase and secondary qualification

On 3 October 2026, review pass 2 was reported **LAND** at `228ac08`.
Rebased with `git rebase --onto origin/main b63234c`: only the two P3-2
commits remain above main `cc8d8c0` (P3-1 #68 and parallel stacks #69).
`git range-diff b63234c..228ac08 origin/main..HEAD` confirmed both rebased
commits have unchanged patches before the qualification changes.
The rebased feature tip is `0e35526`; the commit containing this section adds
the repeatable live journey and its evidence. No push or merge was performed.
The requested live harness and evidence take the whole feature to roughly 1,800
non-generated changed lines; the qualification belongs with the feature in one PR.

The journey uses real Zitadel sign-in in organisation `393311211338337681`,
the running server, projections, OpenFGA, event store and gateway, and a local
recording MCP upstream. Only the reviewed fixture policy, grants and active tool
turn are seeded through events; browser decisions use the shipped API and UI.
The model process shares the server's review-key directory and configures the
existing MCP gateway route. No dependency was added.

The inherited journey locally replaced the selected namespace with
`opencrane-dev`; removing that local variable keeps lifecycle operations in the
selected secondary namespace. Completed viewport journeys return to the signed-in
page so old workspace polling does not compete with the next browser proof.

Fresh stacks now seed a stub-only budget of 20,000 cents daily and 200,000 cents
monthly through an event before the budget writer starts. Repeated Stop journeys
retain their conservative cost; the default daily ceiling previously stopped the
second journey with `budget_exhausted`. Repeat preserves history and the fixture
ceiling. Production defaults and conservative settlement are unchanged.

Two bounded read optimisations were needed for the longer repeat history:

- Historical event reads fetch at most 64 messages concurrently, then yield in log
  order. The real event-store regression crosses the batch boundary, aborts midway
  and resumes from an explicit checkpoint without skipping events.
- Current-authority checks read OpenFGA event receipts in groups of at most 16.
  Every receipt is still required; captured history, facts order, permission checks
  and the two-second freshness fence are unchanged.

**These production read changes postdate review pass 2 at `228ac08`.** That LAND
receipt does not review them; no third independent review was requested or claimed.
The owner must account for this additional scope before landing.

The browser journey uses the existing Check status action after a refused or
ambiguous decision. Only explicit safe-retry confirmation allows another decision
submission, with at most three submissions and three status reads per submission.
Submission counts are logged. Tool checks remain strict: exactly one approved
forward, a refused repeat and no additional forward after denial.

Earlier attempts are not counted as passing receipts. They exposed authority-fence
refusals under host contention, the fixture budget exhaustion described above, and
an incomplete status-read recovery in the harness. Other attempts stopped in the
inherited chat journey or Chromium sign-in (`ERR_NETWORK_CHANGED`). Each claimed
secondary stack was torn down, including failed and interrupted runs. The owner
stack and owner marker were never changed.

Full-suite attempts also exposed timing failures under contention. The 64-message
implementation passed 1,101 tests with 11 skips before receipt batching. Two full runs after receipt batching each had 1,100 passes, one budget-response
assertion failure and 11 skips: one call reached upstream, but some refusals were
HTTP 403 instead of 402. Both budget cases also passed in isolation without changing
assertions or production code. Those failed full runs are not green final gates.
A diagnostic then reproduced dependency timeouts during the eight concurrent
requests. A smaller 16-message read-ahead passed 74 focused tests and fresh startup,
but repeat approval reads exceeded the freshness fence while host load reached
31 on eight cores. The final bound remains 64. Live qualification starts in a
lower-load window; our full-suite tests run after teardown rather than alongside
browser sign-in. The final full-suite command allows the test runner 15 seconds
per test; production freshness fences and explicit timing tests remain unchanged. The 129-event
regression also allows 15 seconds for TLS setup and real appends.

### Final secondary receipt

3 October 2026, secondary stack 1, `http://127.0.0.1:25106`, Node 22.23.3 host
and the pinned Node 22.23.1 model container. The stack was claimed with `claim.sh`;
`DEV_STACK_ID=1` and the requested `ZITADEL_KEY_FILE` path selected the secondary
stack and permitted organisation. Only loopback ports were exposed.

| Command | Result |
| --- | --- |
| `infra/dev-stack/up.sh --fresh` | **PASS**, completed 20:41 UTC; [receipt](p3-2-live/fresh/journey.txt) |
| `infra/dev-stack/up.sh` | **PASS**, completed 20:45 UTC on the same history; [receipt](p3-2-live/repeat/journey.txt) |
| `infra/dev-stack/down.sh --id 1` | **PASS**, exit 0 at 20:47 UTC; both secondary namespaces absent |

Both up commands exited 0. The wrapper exited 143 during cleanup; the explicit
down command above then completed successfully. The owner stack and its marker
were untouched throughout. No real OpenAI call was made.

In **each** run, at **each** width, Ask produced the live 8g card with zero
upstream calls. The requester approved once; exactly one call followed with the
approved bytes and matching durable allow audit. A second retry was refused.
The denied call was refused with no additional upstream call. Requested, approved,
used (outcome unknown) and denied states were restored after reload. Every decision
needed one submission; no status-recovery retries were needed in this final pair.

| Run / state after reload | 390px | 1280px |
| --- | --- | --- |
| fresh / requested | [image](p3-2-live/fresh/requested-390.png) | [image](p3-2-live/fresh/requested-1280.png) |
| fresh / approved | [image](p3-2-live/fresh/approved-390.png) | [image](p3-2-live/fresh/approved-1280.png) |
| fresh / used | [image](p3-2-live/fresh/used-390.png) | [image](p3-2-live/fresh/used-1280.png) |
| fresh / denied | [image](p3-2-live/fresh/denied-390.png) | [image](p3-2-live/fresh/denied-1280.png) |
| repeat / requested | [image](p3-2-live/repeat/requested-390.png) | [image](p3-2-live/repeat/requested-1280.png) |
| repeat / approved | [image](p3-2-live/repeat/approved-390.png) | [image](p3-2-live/repeat/approved-1280.png) |
| repeat / used | [image](p3-2-live/repeat/used-390.png) | [image](p3-2-live/repeat/used-1280.png) |
| repeat / denied | [image](p3-2-live/repeat/denied-390.png) | [image](p3-2-live/repeat/denied-1280.png) |

### Final-source gates

The final full suite passed on 3 October 2026: **68 files passed, two skipped;
1,101 tests passed, 11 skipped, exit 0**, in 1,059 seconds. Command:
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres npm test -- --maxWorkers=1 --testTimeout=15000`.
This was the complete suite without a test filter, after secondary teardown.

| Gate | Result |
| --- | --- |
| `npm ci` after rebase | PASS; no added third-party dependencies |
| `npm run lint` | PASS; existing warnings remain non-blocking |
| `npm run typecheck` | PASS across all workspaces |
| `npm run check:events` | PASS; 76 event types agree |
| `npx tsc -p infra/dev-stack/tsconfig.json --noEmit` | PASS |
| Full `npm test` command above | PASS; 1,101 passed, 11 skipped |
| `npm run build -w apps/web` | PASS; existing bundle/style budget warnings |
| `npm run test -w apps/web -- --watch=false` | PASS; 8 files, 50 tests |

[Safe gate receipt](p3-2-live/gates.txt). Raw local gate logs are under
`/tmp/p3-2-live-logs/`; private stack logs and credentials are not included here.
The shared `origin/main` ref advanced during qualification; this receipt describes
the recorded `cc8d8c0` base plus the P3-2 commits and this qualification commit.

## Not run

Owner-stack qualification (deliberately untouched), paid model calls, native Codex
MCP continuation (P3-5), credential release and charged tools (P3-8), Odoo write/readback,
managed-cluster behaviour and main CI. The real
fixture uses a credential-free connection and profile `none`; it makes no personal
credential-custody claim. Browser step-up navigation and local OIDC tests do not
claim live-provider step-up. Normal sign-in uses the live provider in the permitted
organisation. No paid calls, push, merge or production deployment occurred.

## Rebased approvals, budgets and fold loader

3 October 2026. Source `07f0e22`, rebased onto `f5e3068` (P3-13 budgets and
parallel stacks), with the owner's `a8ba6e0` fold loader and 2.5-second sign-in
handoff cherry-picked as `edb0fa6`. The rebase and cherry-pick both completed.
The independent review returned LAND on its second and final pass.

The decision service retains explicit paying-group attribution, shared-group
authority, all global/group/assistant ceilings, budget configuration and the
default migration. Raw request bytes retain lossless validation; internal budget
and settlement endpoints receive parsed JSON. Model admission fences inside the
reservation queue, reserves against every applicable ceiling, audits and fences
again before forwarding. An audit/final-fence failure releases a known-undispatched
reservation. MCP Allow and Ask both require explicit `costCents: 0`; unsupported
costs refuse before approval consumption. The approval path fences, consumes once,
audits and fences before forwarding. Rejection creates no reservation; lost
consumption acknowledgement cannot authorise a duplicate effect.

All final gates are **PASS**: lint, workspace and stack typechecks, 76-event catalogue,
web build, 51 web tests, and the complete root suite with **1,118 passed / 11 skipped**
(exit 0). The root command used the requested `PG_TEST_URL`, one worker and the
existing 15-second test timeout. Two budget races failed in the earlier focused
invocation; their isolated rerun and the full suite passed without weakening
assertions or freshness limits. See the [gate receipt](p3-2-live/rebased/gates.txt).

The fresh journey is **PASS** on secondary stack **2**, at
`http://127.0.0.1:25206`, using `up.sh --fresh`. At 390px and 1280px, each approval
and denial took one submission; approved bytes reached the recording upstream
exactly once, reuse and denial refused, and requested/approved/used/denied cards
survived reload. Paying-group and assistant ceiling refusals, default-group
migration, replay, real Zitadel sign-in and logout also passed. Explicit
`down.sh --id 2` exited 0 and removed the claimed stack. The owner stack was not
changed. See the [journey receipt](p3-2-live/rebased/journey.txt),
[phone review](p3-2-live/rebased/requested-390.png),
[desktop used card](p3-2-live/rebased/used-1280.png) and
[budget refusal](p3-2-live/rebased/budget-paying_group-390.png).

Two earlier fresh attempts failed before approval qualification and were torn
down. The second exposed a stale Angular/Vite protocol bundle missing the new
budget exports. Moving aside only this worktree's generated cache fixed loading;
the successful run used unchanged source. Private diagnostic logs stayed outside
Git; safe local gate/journey logs use `/tmp/p3-2-rebase-*`.

Paid-provider calls, native Codex MCP continuation and charged/credential-bearing
tools remain **NOT RUN**, as in the original qualification. No push occurred.
