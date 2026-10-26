# Local dev stack

For people, read [README.md](README.md) first.

## Personal Memory response collection

`memory-personal-browser.ts` comes from the draft personal Memory journey. It records
the first scopes reply status before reading its body. That body read stops after
ten seconds and records an unavailable body separately. An applying reply can wait
for the browser to recover through its own GET retries; the collector sends no retry.
The browser journey below uses the same response collector.

`nice -n 10 node --experimental-strip-types --test
infra/dev-stack/memory-personal-browser.test.ts` checks a stalled body and a complete
reply without starting a development stack.

## Personal memory qualification

Part of #94 and #95. `memory-personal-live.ts` uses an empty secondary installation,
real SSO and the free model stub. Start with `DEV_OWNER_BOOTSTRAP=0` and `--fresh`.
Supply the id returned by `claim.sh` as both `DEV_STACK_ID` and `MEMORY_CLAIMED_ID`.
Set `ZITADEL_KEY_FILE` to the existing setup credential path for stack startup.
The launcher refuses an existing observations file. Preserve earlier evidence before
starting a separate attempt; do not combine attempts into a passing result.

```sh
nice -n 10 node --experimental-strip-types infra/dev-stack/memory-personal-live.ts
nice -n 10 node --experimental-strip-types --test infra/dev-stack/memory-personal.test.ts
```

The collector signs in, claims the empty silo and records the first scopes reply.
It then saves, searches, opens, corrects and forgets a synthetic personal fact through
browser controls. Once the response body is available, it saves the write receipt
before checking the outcome. Write-response body collection still has no timeout.
After stack startup, configure the test contact email privately in
`memory-owner-email` inside the claimed slot directory. The collector reads that file;
the browser session stays in that directory too.
New evidence goes into `docs/process/memory-fresh-personal/permissions-fixed-rerun/`; the launcher
refuses an existing observations file. Earlier attempts remain separate.
The acceptance checker additionally requires original receipts, GET-only lost-reply
recovery, retained correction, completed cleanup and absence of forgotten text after
reload, restart and replay. Its unit tests use synthetic evidence.
The runs use temporary collectors for those additional checks. They are not yet part
of the tracked launcher. The receipt distinguishes their results and failures.
The latest fresh run passes desktop and phone save, search, correction and forgetting.
The browser recovers from applying permissions through its own GET retries. Lost-reply
recovery sends one status GET without repeating the write. Another member cannot read
the owner's facts. Reload and server restart retain the corrected fact and exclude
both forgotten facts. The receipt records the offline rebuild and final acceptance.
Memory replay refuses `--verify`; the operator compares HTTP readbacks instead.
The checker requires unchanged event counts and zero local model requests during replay.
No helper inspects private memory key files. Native memory remains off and NOT RUN.
Resizing recreates the panel; submitted forms stay at one width until the receipt is read.
Release the claimed slot with `down.sh --id` after inspecting the saved pictures.
See [the qualification receipt](../../docs/process/memory-fresh-personal/receipt.md).

## First demo read turn

The local reply fixture understands both direct MCP namespaces and Codex's
`functions.exec` interface. Codex may leave deferred MCP definitions out of the
first model request. The fixture searches `ALL_TOOLS` inside the offered code tool,
requires one matching published tool and calls that exact name once. Its next
response quotes the tool's returned data. Missing or ambiguous tools cannot cause
a guessed call; failed results cannot become invented quotes.

`scripts/stage-b-read.test.mjs` runs the real demo server, gateway, NATS, PostgreSQL,
OpenFGA and packaged Codex with the product's thread loader and forwarding proxy.
It uses the ordinary saved-policy fixture and operator gateway route. Browser
publication and generated gateway configuration remain live-rehearsal work.
The computer container has `--network none`; a Unix socket reaches only the local
fixture services. There are no paid calls. The test runs with an existing executor
home and with that directory absent. It saves one dispatch record, checks two model
requests and requires a completed same-turn answer containing the returned quote.

Set `PG_TEST_URL` to a disposable database. The default image is
`ocn-upload-computer:test`, already built by the CI image fixture job.
`CODEX_CAPTURE_IMAGE` can select the rehearsal computer image instead.
`STAGE_B_READ_EVIDENCE` optionally retains private request bodies, streamed replies,
dispatches and Codex notifications outside the repository, under one folder per case.

```sh
nice -n 10 npx vitest run scripts/stage-b-read.test.mjs --maxWorkers=2
nice -n 10 node --experimental-strip-types --test infra/dev-stack/stage-b-model.test.ts
```

The [offline diagnosis](../../docs/process/stage-b-read-failure/receipt.md) records
the failing-first results and the remaining live checks. The live rehearsal branch
must retain its launcher and use this corrected shared fixture when rebasing.

## Local tools rehearsal checks

The first split of P3-4/P3-5 PR 14a supplies test helpers, not a live journey.
`test/demo-remote.ts` runs the real `apps/demo-mcp` routes behind the TLS server from
`@opencrane/models/testing/remote-mcp`. It accepts only `https://mcp.example.test/`.
It checks the public pin, TLS verification, SNI hostname and disabled connection
pooling before the shared fixture maps the connection to loopback.
Production DNS and address checks still run. No production startup path imports it.

`requireStageBStack` checks the requested and claimed secondary ids before reading
the owner marker. It rejects foreign and redirected directories before any settings
read. The caller must obtain the claim through `claim.sh`.

`checkStageBApproval` checks supplied policy, original grant command references,
IAM/content receipts, the matching gateway generation and process, requester approval,
same-turn reply, fixture readbacks and zero tool spending. `rehearsedAt` records the
rehearsal time. The product's `isToolPolicyAvailable` must accept the policy at that
time. The saved catalogue must contain valid definitions whose names, revisions,
read-only flags and zero costs match the reviewed choices.

`records` contains the original event envelopes and global event-log positions for
`tool.approval_requested`, `approval.decided`, `approval.used`, `decision.recorded`
and `tool.dispatch_recorded`. Each record must belong to the same silo and its expected
stream. Their positions must increase in that order, and their times must agree with
that order and precede or equal `rehearsedAt`. The approval, consumed permit and dispatch
must refer to the same call, conversation, turn, requester, assistant and write tool.
The request must match the reviewed revision, connection, catalogue and arguments.
The dispatch must start after the saved decision and before the approval expires.
Missing records, unrelated records and dispatch before approval are refused.

Its input is collected
evidence, not an authentication mechanism. The caller must obtain those records from
the product and take the readbacks at the stated stages. Synthetic records in its
unit tests are not live qualification. Model spending reconciliation, browser capture,
reload, Change history and collection of those records remain in the next split.

```sh
nice -n 10 node --experimental-strip-types --test infra/dev-stack/stage-b-local.test.ts
```

The test calls discovery and the shared remote HTTPS exchange directly. It does not
run the catalogue worker, gateway or Codex. The next split must inject the same adapter
at discovery, watch and dispatch while keeping server and models processes separate.
It must run the one fresh browser/chat journey before reporting live qualification.
Native shell and file-edit consent remains NOT RUN under the 23 October decision.
See [the receipt and remaining work](../../docs/process/demo-stage-b-local/receipt.md).

## Guarded local launch

Part of #574, PR 14b. `stage-b-live.ts` runs after one fresh secondary start.
It checks the requested id, claimed id and worktree marker before reading settings.
It refuses real-provider mode. It keeps the existing server environment and the
models Compose service, including its separate network and gateway process.
Before stopping the server, it builds `Dockerfile.stage-b` from the same pinned
Node image. The test image adds Debian main OpenSSL 3.0.22-1~deb12u1 for certificate
generation. Its installed copyright file declares Apache-2.0. This image is only
for the rehearsal; customer runtime images are unchanged.
The PID and start time must still match before the server is stopped.

`stage-b-entry.ts` checks both production entrypoint sources before loading services.
A test-only Node load hook changes exactly three arguments: server discovery,
models catalogue watch and models dispatch. Missing or repeated matching code refuses
launch. Every other statement stays unchanged. Product entrypoint files are not
edited and do not import fixtures. No production setting enables this transport.
Dispatch receives the adapter through `McpDispatchOptions.remoteNetwork`. The launch
test evaluates the generated options and checks this property, so a misspelt setting
cannot silently select ordinary DNS.

The rehearsal Compose override mounts `stack-owner` and `stage-b-demo.sock` read-only.
The ordinary secondary configuration supplies the remaining models files. It does not
mount the whole stack directory. A disposable container test checks the slot guard,
the demo socket, the read-only claim and the absence of personal keys. This keeps the
local launch compatible with the private-directory isolation introduced by #646.

Each process uses `test/demo-remote.ts` for the synthetic hostname's public DNS pin,
SNI, certificate checks and fresh TLS connections. Behind TLS, the adapters forward
to one Unix socket in the owned stack directory. `apps/demo-mcp` owns that socket
and the shared fixture state. A missing socket refuses before services start.
The transport test writes through one adapter and reads the actual effect through
another. Those direct calls are test coverage, not approval qualification.

The free model understands `STAGE_B_READ` and `STAGE_B_WRITE` rehearsal messages.
It calls only the matching tool offered by Codex and refuses a missing tool. It
answers with the returned quote after receiving a tool result, without repeating the call.
The model loads the tools helper only for those rehearsal messages. Ordinary replies
still run from the single-file model stub used by the wake Pod check.
The evidence checker still requires original approval and dispatch records.

```sh
DEV_STACK_ID=1 STAGE_B_CLAIMED_ID=1 nice -n 10 node --experimental-strip-types \
  infra/dev-stack/stage-b-live.ts
```

The ids above must be the slot returned by this worktree's `claim.sh`.
The launcher stays running during the browser check. Stop it before running
`infra/dev-stack/down.sh --id` for that same slot. The normal down command removes
the owned Compose service and its generated override file. Never use this launch
against the owner or another worktree's claim.

The tracked collector is `scripts/collect-stage-b-evidence.mjs`. It replaces the
untracked sixth-run probe. It uses the claimed slot's existing signed-in browser
state and a new output directory containing the original `publication.json`.
It refuses existing `live-probe.json` or `live-probe.jsonl` files rather than
replacing an earlier run. A future authorised journey can run it with:

```sh
DEV_STACK_ID=1 STAGE_B_CLAIMED_ID=1 nice -n 10 node --experimental-strip-types \
  scripts/collect-stage-b-evidence.mjs /path/to/new-evidence-directory
```

`stage-b-collector.ts` saves every observation synchronously to `live-probe.jsonl`
and flushes it to disk before updating `live-probe.json` by an atomic rename.
The journal keeps earlier values when a later observation replaces a summary field.
Each original event is saved before reading the next one. The HTTP readback keeps
its original response body and status before parsing or checking the quote.
Quote checks refuse unexpected fields. The refused response is still saved.
Approval commands and response status are saved before waiting for the body.
An unfinished browser body never holds up saving other evidence. Both files redact
email addresses and use mode `0600`. A collector interrupted during a summary write
leaves the previous complete summary and the saved journal. `checkStageBApproval`
is unchanged and still refuses an incomplete set of original proof.

Offline checks use a disposable demo server, child process and browser. They stop
the child immediately after its first readback, fail an event stream after one
original record, and close the browser during an unfinished approval response.
These are ordinary test fixtures; they do not run a live product journey.
The existing CI Node test step selects this regression and the launch and network
checks. The test-selection guard requires all three file paths.

```sh
nice -n 10 node --experimental-strip-types --test infra/dev-stack/stage-b-collector.test.ts
```

Results and remaining conditions are in
[the local live receipt](../../docs/process/demo-stage-b-local-live/receipt.md).
The latest fresh run passed the baseline, publication, read, requester approval,
exactly one write, reload, drawer and spending/history checks. The tracked collector
saved the original demo readback bodies and events and exited normally. The unchanged
`checkStageBApproval` accepted the complete proof during collection and from disk.
All 46 public captures were inspected. The separate owner's personal browser login
remains NOT RUN and needs the owner. Earlier failed and incomplete runs remain in
the receipt. No product or collector code changed during this rerun.
Native consent, public deployment and the later repeated or long-wait journeys
remain excluded from this launch.

## TypeScript checks

`npm run typecheck:dev-stack` runs `tsc --noEmit` with this folder's existing
`tsconfig.json`. It includes every top-level `.ts` script and test and the modules
they import. It inherits the strict settings in `../../tsconfig.base.json`.
The root `npm run typecheck` runs it after the workspace and package checks, so
the existing CI Typecheck step also checks this folder.

The MCP journey loads the local TLS fixture through
`@opencrane/models/testing/remote-mcp`. Its import stays after the secondary-stack
guard. The wake measurement forwards the optional verifier and the force flag in
the same argument positions as `SandboxClient.credentials`.

The rehearsal refusal test keeps its 100 ms assertion timeout. The nested-main test
keeps its one-second assertion timeout. Both use a separate 30-second timeout for HTML
setup, matching Playwright's default, so a busy browser can load each fixture before
its assertions start.

## Spending editor diagnostics, 23 October 2026

Part of board card #600 and the #32 demo work. **Diagnostics only: no root-cause fix
is claimed.** The cause remains unproved. The card stays open until a failure is caught
and fixed, or several fresh runs pass. The final rehearsal and nightlies run the
spending check; this change records evidence if its editor fails to appear.
The retained attempt
`nightly-20261022T232200-238bd706-cd43-4315-bb24-b449c3adc9c4`, source `267e038bb`,
failed in the `save` helper at line 50, called from line 89. It waited for the
**Budget scope** select on a new Spending page before submitting the next ceiling.
It was not waiting for a refusal notice, save reply or restored limit.

Evidence is under `~/.opencrane/daily-fresh/` in that attempt's directory.
`last-error.log` gives the 30-second locator timeout. The retained
`generated/docs/process/p3-13-live/fresh-paying_group-1280.png` shows a saved zero-cent
paying-group ceiling. The matching refusal picture shows the group limit notice.
There is no picture of the failed Spending page. The server log retains only its last
100 lines, which cover later sign-out checks. Those records do not establish the
failed page's HTTP responses, rendering state or exact trigger.

The Spending editor, its read handlers and this browser check are unchanged between
that source and the investigation's `origin/main` base `bc769a1c3`.
A diagnostic fresh start on claimed secondary slot 1 passed all four budget cases,
both replay checks and sign-out. Thirty additional read-only page loads and sixty
further UI saves alternating zero and 20,000 cents also passed. The read-only observer
ran before the budget cases and may have warmed the page. This is not an exact
reproduction of the original cold load. The observer and temporary instrumentation
were removed. The slot was released. Pictures and generated records are retained at
`~/.opencrane/daily-fresh/budget-diagnostic-20261023/generated/`.

The lasting change records evidence from the next failed editor load in
`budget-editor-failure.log`. It keeps only HTTP status codes for the original page's
GETs to the exact `/api/org/models` and `/api/org/effects` URLs on the chosen origin.
It also records whether the Budget scope control, budget-service warning, access
warning and Spending loaded notice are visible. Each value is `true` or `false`, or
`null` if the browser cannot inspect that part of the page.

The log contains fixed keys, status codes and these visibility values. It excludes
URLs, response contents, page text, input values and driver errors, which could contain
secrets or personal data. A separate `budget-editor-failure.png` now keeps a picture
of the failed page. Both files use owner-only permissions. The picture stays with the
stack’s other private failure pictures; it must be checked before sharing. The
nightly launcher's existing log retention keeps it before removing the stack.
The browser adds no HTTP reads, refreshes, write retries or longer waits. Reading
visibility does not wait for the page to recover. The journey still fails before Save.

The original failing-first tests proved missing failure evidence, **not the original
fresh-start defect**. The tests copy the real journey into a temporary fixture directory
so they cannot touch a running stack's files. They check an unavailable read, an access
refusal and a successful HTTP read followed by a missing editor. They also check that
unreadable page states do not lose the status codes, that private pictures are saved,
that non-GET and unrelated URL responses are excluded, and that effects responses are
kept separately in arrival order. A failed picture cannot replace the original load
failure or prevent its log from being saved. Money, company limits and access checks
are unchanged.

### Stack-free checks, 24 October 2026

Part of #574. The fourth baseline failure on `work/demo-stage-b-local-live` had no
captured budget or effects HTTP response. Its page showed Budget service unavailable.
Later reads and saves returned 200. Those later responses do not explain the failure.

`browser-budget-editor.test.ts` builds the real website and intercepts its APIs in
Chromium. It checks correction after a refused save, repeated scoped saves at 1280px
and 390px, and the final paying-group, assistant and global saves. A forced connection
reset checks that the real failure picture is a private PNG. That reset produces the
same recorded states as the baseline, but it does not prove that a connection reset
caused the live failure. The test adds no dev stack or database. It does not run
member turns, server access checks or projections.

CI runs this browser file in the checks job, after Chromium installation, with
one test worker. The CI grouping check rejects any dev-stack test file missing
from the workflow's Node test commands unless it has an exclusion with a reason.

An exploratory run also passed 60 page loads and 120 save attempts, including a
refusal and correction on every page. The original failure did not recur. Its cause
remains unproved. Reproducing the exact baseline now needs a live stack; no live stack
was started for this investigation. These checks do not qualify a fresh installation.

```sh
nice -n 10 node --experimental-strip-types --test infra/dev-stack/browser-budgets.test.ts infra/dev-stack/browser-budget-editor.test.ts
```

### Qualification and local checks

The one nightly attempt was **PASS**: source
`c985529bf446f0fa9508e1e7536435c5c1edf040`, attempt
`nightly-20261023T002814-dd233c55-c917-4973-97c3-9240567e1419`, completed at
00:46:36 UTC on 23 October after 1,102 seconds. It used fresh claimed secondary
slot 1 and the free stand-in, without the diagnostic observer. This is retained evidence
from the earlier implementation, before the current rebase and privacy change. It does not qualify the current revision. The original intermittent
failure remains unresolved.

| Spending and every following check | Result |
| --- | --- |
| Paying-group zero ceiling, 1280px and 390px, durable refusal after reload, no reservation | PASS |
| Assistant zero ceiling, both widths, durable refusal after reload, no reservation | PASS |
| Restore the chosen ceilings and save final daily/monthly limits | PASS |
| Group list, creation, search and detail | PASS |
| Shared assistant creation, readiness, member choice and private chat | PASS |
| Review and remove group membership | PASS |
| Direct chat at both widths, exchange without starting an agent | PASS |
| Group chat creation and fixed mode; messages without AI, computer or budget activity | PASS |
| Add from the join position, remove and leave with access cleared | PASS |
| People picker and refusal of an unsupported recipient combination | PASS |
| Group participants and mode preserved through server restart and conversation replay | PASS |
| Members replay and MCP catalogue replay, each with `--verify` | PASS |
| HTTP web page and loopback listeners | PASS |
| Token privacy in browser and logs, form sign-out and credential-required reauthentication | PASS |
| Paid-model answer | NOT RUN |
| Separate member disks for shared assistants | NOT PROVEN |

The retained group receipt contains 26 PASS assertions and the two explicit limits
above. The launcher released slot 1; its directory and Compose containers were absent
afterwards. Generated pictures and JSON records were retained privately, then restored
in the repository. Evidence, including the group receipt and local check logs, is at
`~/.opencrane/daily-fresh/nightly-20261023T002814-dd233c55-c917-4973-97c3-9240567e1419/`.

Earlier implementation checks: **PASS**, six focused tests twice, 438 event-security tests once,
workspace/package typecheck and a strict check of the changed infrastructure files
using the repository's compiler settings. **PASS**, lint including Knip, Markdown,
offline links, fixture rules, reviewed licences and changelog validation; 24 warnings
are in unchanged code. **PASS**, event catalogue agreement for 149 types.
All checks used `nice -n 10`. Focused and security tests used the requested
`PG_TEST_URL`; these tests use no database. **PASS**, clean `npm ci` and both requested
tool symlinks. Full root suite: **NOT RUN**, as requested. Protected authority and
security tests are unchanged. CI will not be awaited.

### Diagnostics rework receipt

Rebased successfully onto fetched `origin/main` at `f377da0af2c0b01d92f23783d2ba4728ef57d175`.
The fetched main commit is an ancestor of this branch and no rebase remains in progress.
The test-only commit `fcbbb85c0` ran before the privacy change: **FAIL**, as expected,
because the old capture had no fixed page-state record (three tests passed, six failed).
This is proof of the diagnostics change only; no product failure was reproduced.

Current local checks:

- **PASS**, all nine focused tests twice after the final readability changes. Both runs
  used `PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`. These fixtures
  need no database and cannot touch the live stacks.
- **PASS**, removal checks for all three response guards. Removing GET filtering,
  bypassing the exact budget URL or disabling effects capture each made its new test
  fail. Reintroducing a raw screenshot also made the privacy test fail. All temporary
  changes were restored before the passing checks.
- **PASS**, repository lint, including Knip, Markdown, offline links, fixture rules,
  reviewed licences and `npm run lint:changelog`. Lint reports 24 existing warnings
  and no errors. Knip reports two existing configuration hints.
- **PASS**, workspace and package typecheck, plus a focused strict typecheck of the
  changed infrastructure files using the repository's compiler settings.
- **PASS**, `check:events`: 149 event types agree with the catalogue.

All checks ran under `nice -n 10`. Lint used a 6 GiB heap. Check logs are retained at
`~/.fleet/demo-budget-check/rework/`. Protected access, money, memory and event-security
checks are unchanged.

Fresh live run on this revision: **NOT RUN**. Full root suite: **NOT RUN**, as requested.
The earlier nightly above remains the only recorded fresh pass for this investigation.
The cause remains unproved and #600 stays open. This PR remains a draft. CI is not awaited.

## Starting and stopping the stack

On `ocn-dev`, with Node 22, installed workspaces (`npm ci`), Docker Compose,
OpenSSL, `flock`, passwordless `sudo` for Tailscale Serve and the model-port firewall, and an authenticated
Tailscale daemon:

```sh
infra/dev-stack/up.sh --fresh
infra/dev-stack/journey.sh
infra/dev-stack/status.sh
infra/dev-stack/down.sh
```

By default, `up` runs the core journey. `--fresh` first stops this stack, deletes its
three Compose volumes, computer namespace and generated service credentials, then provisions
from nothing. The `zitadel-*` files and `zitadel.json` are retained: cloud identities survive fresh installs.
Plain `up` reuses data and running processes; owner `down` retains data and credentials.
Secondary `down --id` deletes that stack’s volumes, namespaces, admission policies
and generated directory, releasing its claim. Failed starts retain the claim for diagnosis.
Fresh secondary startup clears only this worktree's `apps/web/.angular/cache`, after
stopping its website. The daily checkout keeps installed packages when the lock file
is unchanged, but local workspace exports can change between commits. Reusing Vite's
saved dependency bundles can otherwise leave the sign-in page blank with a missing export.
These scripts do not touch `pg-test` or the `ocn` registry/MinIO; on `ocn` they
own the `opencrane-<silo>` computer and `opencrane-<silo>-gateway` relay namespaces.
Run at most three stacks per host: the stable owner and secondary ids `1` and `2`.
Operations use a separate `flock` per id; different stacks run concurrently.
Service readiness waits allow two minutes on secondary stacks and one minute on the owner.
Website readiness has its own five-minute deadline, measured with a monotonic clock.
It still requires a successful HTTP response from `/org/integrations` on the Angular
server, started with the generated proxy configuration. If the recorded website process
stops, startup fails promptly and points to the private `web.log`, without printing
its contents. A successful check prints
`PASS website readiness: <milliseconds>ms`, measured from the request to start or reuse
the website process.
The origin check and browser journeys run afterwards. Fresh starts still clear the cache.

The retained 22 October provider-start run built the website in 208.291 seconds, then
listened on slot 1's port 25106. Its previous two-minute wait had already failed.
The same day's upload-list run retained only `Building...` and a web timeout, so it does
not establish that run's eventual build time. The cache change in #578 only enabled
Angular caching in CI; fresh secondary starts remove this cache before the build.
No new web dependency was introduced by that change. Keep the cold-build allowance
separate from the other services' deadlines.

`nice -n 10 node --experimental-strip-types --test infra/dev-stack/stack-start.test.ts`
checks a simulated 208.291-second build, a website that never becomes ready and an exited
website process. It also checks owner rollback with synthetic processes; it never starts
or changes the live owner stack.

Repeated startup stops the secondary model container before migration and starts
it again afterwards, alongside the restarted server and dispatcher. Fresh secondary
stacks seed a 100,000-cent daily/monthly budget event for the stub-only journeys.
Stop leaves uncertain reservations; repeat runs retain them and the same ledger.

## Website startup check, 22 October 2026

Source: `db18a7bf1882515421a8955010e898183fcb183f`. Both attempts ran
`nice -n 10 infra/dev-stack/daily-fresh.sh` with `ZITADEL_KEY_FILE` pointing to the
existing private credential file. The launcher claimed secondary slot 1 with `claim.sh`,
ran `up.sh --fresh` with the free stand-in model, then removed the slot and its volumes.
No separate test suite or repository build from this task ran during either attempt.

- First attempt: **FAIL** before website startup. The provider create request returned
  HTTP 503, then its receipt request returned HTTP 404. Website and browser checks:
  **NOT RUN**. Private sanitised logs are in
  `~/.opencrane/daily-fresh/nightly-20261022T211218-233b6bf6-5e86-4319-a7c1-78840cb8eb99/`.
- Second attempt: website readiness **PASS**, **56,406 ms** from launch to the successful
  HTTP check. Angular reported **51.681 seconds** for the cold build and listened on
  `127.0.0.1:25106`. The generated proxy and origin check were used.
- Browser checks **PARTIAL**: the run passed sign-in, a streamed stand-in reply, reload,
  Stop, upload and preview assertions, then timed out after 120 seconds waiting for the
  attached PDF's answer in `browser-upload.ts`. The whole fresh run remains **FAIL**.
  Later browser journeys and replay checks: **NOT RUN**. Private sanitised logs and
  screenshots are in
  `~/.opencrane/daily-fresh/nightly-20261022T211505-1d48d147-b640-4a88-9e05-da853665efd4/`.
- Cleanup **PASS** for both attempts: slot 1's generated directory was removed and no
  Compose containers remained for `opencrane-dev-1`. The owner stack was not used.

The earlier provider-start task retained its eventual **208.291-second** Angular build
in `<home>/.fleet/demo-provider-start/events.jsonl`. The upload-list failure logs
are under `~/.opencrane/daily-fresh/nightly-20261022T193759-c67e4dbf-24db-4d87-9faf-333d9bbb15fc/`.
The earlier task also recorded a host load average of 28.53 after that build. The website
still uses two build workers and a 768 MiB JavaScript heap on a secondary stack. That
measurement justifies allowing five minutes even though the second attempt here was faster.
This check does not qualify every demo journey or a paid model.

Local checks: **PASS**, 18 startup and model-environment tests twice, 438 event-security
tests once and the event catalogue check (149 event types). The regression failed before
the fix in test-only commit `7b26ad748`. All checks used `nice -n 10`; the event-security
run set the requested `PG_TEST_URL` and did not use a database.
Workspace typecheck and the focused strict typecheck for the changed startup code: **PASS**.
Repository lint, including Knip, Markdown, links, licences and changelog checks: **PASS**
with `NODE_OPTIONS=--max-old-space-size=6144`. The initial lint attempt exhausted Node's
default 4 GiB heap before reaching the later checks. CI already gives lint an 8 GiB heap.
Full root suite: **NOT RUN**.

## Owned local qualification target

Part of #15, P5-4 PR 3a. `run.sh target-up --id 1` creates a dedicated k3d
cluster only after this worktree obtains that slot through `claim.sh`.
The fixed name is `opencrane-target-1` (or `-2`), with one server and two agents.
The API binds loopback port 25113 (or 25213). There is no load balancer, registry,
image volume or change to the default kubeconfig. The existing devbox k3s digest
is reused. This helper installs no product services or computer prerequisites.

Each node starts with a 768 MiB memory limit. After creation returns, each receives
a one-CPU limit before readiness is checked. k3d does not offer a creation-time
CPU limit. A failed create or later startup error removes the attempt's checked Docker
nodes and network before returning. If cleanup fails, the owner record stays for a
later retry. An abruptly killed launcher can still leave nodes awaiting cleanup.
The slot cannot
also run Compose or another package. The owner-plus-two limit is unchanged.
All four k3s data directories bind into the slot's private `target-data` folder.
No Docker volume may remain attached when ownership is accepted or cleanup starts.

`target-owner.json` saves a random attempt ID before creation, then Docker network
and container IDs and Kubernetes node UIDs. Labels carry the attempt ID. An
interrupted create can be removed only when those labels and saved IDs agree.
`target-check` verifies the recorded target. `target-down` removes its package
first, checks identities, removes Docker resources by ID and confirms their absence
before deleting storage and ownership. Ordinary secondary `down` also does this.
A record keeps the claim busy even before a namespace exists or after the launcher
and 15-minute grace period end. Uncertain Docker or Kubernetes state retains it.
A partial target must be cleaned up before another creation attempt.

`claim.test.ts` uses `test/claim-ports.mjs` in its child processes. It keeps the
real port checker but gives its socket probes ports chosen by the operating system.
The occupied-model-port case maps that probe to a real listener held by the test.
All existing slot refusal and reclaim assertions still run. These fixtures can
run beside a live secondary stack without using its ports or changing its processes.

Commands capture output in memory and discard dependency errors. The kubeconfig
and ownership file are mode 0600. Inspection takes at most ten seconds per command;
creation has a 150-second command limit and a 120-second k3d limit. Node registration
and readiness each have a separate bounded wait. Package ownership and cleanup
use the checked context and private kubeconfig; arbitrary contexts are not accepted.
Preparation, bootstrap and browser integration remain PR 4 work. Live creation,
three-node placement and failure drills are NOT RUN until `p5-4-live1`.

## Parallel journeys

The default id, `owner`, keeps the existing directory, project, ports, data and
Tailscale Serve endpoint. Never transfer its ownership marker for a feature journey.
Use the command interface below from each worktree, after `npm ci`:

```sh
stack_id=$(infra/dev-stack/claim.sh) || exit 1
export DEV_STACK_ID="$stack_id"
# Point to the existing PAT file when this worktree has no .keys directory.
export ZITADEL_KEY_FILE=<worktree>/.keys/.zitadel-key
infra/dev-stack/up.sh --fresh
infra/dev-stack/status.sh
infra/dev-stack/journey.sh
infra/dev-stack/down.sh
```

`up` includes the core journey. Every command also accepts `--id 1` or `--id 2`,
overriding `DEV_STACK_ID`. A missing id selects `owner`; other ids are refused.
`claim.sh` prints one free secondary id, or exits non-zero when both ids are in use.
The owner file records the worktree, claiming process id and claim start time. A
worktree that claims again gets its existing id. A claim stays reserved for 15 minutes
from its `startedAt` timestamp, even after the claiming process has ended. This gives
`up --fresh` time to start the stack. After that, a slot is stale when its claiming
process has ended and no recorded host process, running Compose container or
package namespace or recorded qualification target remains. The package owner record keeps the worktree, slot,
cluster, namespace UID, Helm release and heartbeat. Kubernetes errors count as
busy. `package-down` checks those identities before removal; ordinary secondary
`down` does the same first. Package preparation checks for running Compose host
processes and containers in that slot. The installer saves a random `installId`
before Helm runs and passes it as the `opencrane.dev/install-id` release label.
Cleanup requires that label to match the saved ID. If the launcher stops before
saving the release Secret's UID, cleanup recovers the UID from the matching Secret.
A later foreign or unlabelled release is refused, even in the owned namespace.
Older records without an install ID cannot authorise release removal.
If Kubernetes is unavailable, secondary `down` still
stops Compose, keeps the package record and reports that the package remains.
Without a package record, `down` skips Helm namespace checks. It removes computer
resources only when `quota.json` exists; that file is saved before the first
Kubernetes call during computer setup. With neither record, teardown makes no
Kubernetes calls.
See [package operator notes](../package/README.robot.md).
The package installer reads the server Service ClusterIP after Helm creates it.
It writes that IP to the computer ConfigMap before waiting for the first owner.
Old owner files containing only a worktree path count as claims started long ago.
The next claim reports the reclaim on stderr and records the new owner. `status`
prints `free` for an unused or stale slot, and `status` and `down` never create its
directory or owner file. Successful `down --id` removes the secondary directory.
Locks close before detached servers start, so those servers cannot keep an
operation lock held after the command finishes.

| Resource | Owner (default) | Id 1 | Id 2 |
| --- | --- | --- | --- |
| Directory below `~/.config/opencrane/` | `dev-stack` | `dev-stack-1` | `dev-stack-2` |
| Compose project | `opencrane-dev` | `opencrane-dev-1` | `opencrane-dev-2` |
| Computer namespace | `opencrane-dev` | `opencrane-dev-1` | `opencrane-dev-2` |
| PostgreSQL / NATS / OpenFGA | 55433 / 44222 / 48080 | 25100 / 25101 / 25102 | 25200 / 25201 / 25202 |
| MinIO API / console | 49000 / 49001 | 25103 / 25104 | 25203 / 25204 |
| Server / browser | 48000 / 44200 | 25105 / 25106 | 25205 / 25206 |
| Model gateway / decision / readiness / stub | 43000–43003 | 25107–25110 | 25207–25210 |
| ClamAV | 43310 | 25111 | 25211 |

Relay namespaces append `-gateway`. Each stack has its own namespace-only lifecycle
ServiceAccount and RBAC, NATS CA/certificates/NKeys, PostgreSQL passwords (including
OpenFGA’s database role), MinIO password, session encryption key and lifecycle
signing key. Compose prefixes its networks and volumes with the selected project.
Secondary directories and ports are fixed by id; conflicting overrides are refused.
The fixed secondary blocks are below this box’s ephemeral range (32768–60999),
so outgoing Kubernetes/database sockets cannot claim a future listener.
Claims probe the whole port block on IPv4 and IPv6 and skip occupied slots.
Startup checks every port before starting services and refuses foreign listeners.
Existing listeners are reused only when owned by this stack’s recorded process
groups or running Compose containers.

Secondary model processes share their NATS container’s network namespace. The
pinned Node runtime image is already used by `apps/computer/Dockerfile`; no new
runtime package is added. Docker publishes every secondary host port on loopback.
The relay reaches the gateway through its private `k3d-ocn` container address;
secondary startup/shutdown never changes host firewall rules. The existing owner
keeps its host gateway and firewall unchanged.

Secondary browsers use `http://127.0.0.1:25106` or `http://127.0.0.1:25206`.
They never call Tailscale Serve. Sessions remain HttpOnly/SameSite=Lax; local HTTP
uses non-Secure cookies with distinct names per id because cookies ignore ports.
Real Zitadel login, organisation pinning, CSRF checks and PKCE still apply. Browser
contexts and screenshots are separate; secondary screenshots live in their private
generated directories. Paid providers require the explicit opt-in below.

The limit is **owner plus two journey stacks on the 8-core, 16 GiB box**. Each
secondary caps Compose services to 0.5 CPU each and 256–512 MiB each (models: one CPU / 768 MiB), Angular to two
build workers and a 768 MiB JS heap, other Node processes to 256 MiB JS heaps, and
computers to four Pods / 2 GiB of memory limits / four 1 GiB PVCs. The warm pool
stays at zero. These are dev qualification limits, not production sizing. Run one
journey per stack, avoid concurrent repository builds while qualifying, and tear
down secondaries when finished. Exhausted slots queue instead of creating a fourth
stack; do not work around the limit with custom directories or ports.

The [parallel qualification receipt](../../docs/process/parallel-stacks-evidence.md)
records concurrent journeys, owner continuity, failures and teardown evidence.

## Services and identities

Compose pins PostgreSQL 17, NATS 2.15.0, OpenFGA 1.21.0 and the same MinIO image
as `infra/devbox` by digest. Licences are PostgreSQL, Apache-2.0 (NATS/OpenFGA)
and AGPL-3.0 (MinIO), all OSI-approved. No new package dependency is introduced;
the worker adds the existing handlers workspace to the ops package.

All published ports bind to `127.0.0.1`: PostgreSQL 55433, NATS 44222, OpenFGA
48080, MinIO 49000/49001, server 48000 and Angular 44200. Container listeners
are inside the Compose network; no gRPC, metrics or NATS monitoring port is
published. `pg-test` keeps 55432. Override the corresponding `*_PORT` variables
when generating a new owner stack; secondary port blocks are fixed in `identity.ts`. Clients receive URLs via environment
and a generated Angular proxy file; application code has no Compose branch.

`npm run provision` uses only the command NKey/TLS identity. The server receives
that identity and a read-only PostgreSQL role. Separate members and MCP catalogue
processes use the projection NKey and own the projection database. The computers
projection does the same. The dispatcher keeps `DATABASE_URL` from `dispatcher.env`
for jobs. Startup supplies `CONTENT_DATABASE_URL` from `server.env`'s `DATABASE_URL`,
including on an existing installation. That read-role connection takes the gateway
configuration lock in the same database used by models delivery. Missing configuration
refuses dispatcher startup. The dispatcher uses its own NKey; pg-boss
updates OpenFGA and runs the lifecycle reactions. OpenFGA uses its own PostgreSQL
database. Startup installs the checked SandboxTemplate, zero-size pool and
namespace-only ServiceAccount on k3d `ocn`, then writes a short-lived kubeconfig
beside the other generated credentials. The worker entrypoint is also usable
outside this stack: `npm run worker -w apps/ops -- members|mcp-catalogue|computers|dispatcher`.
It uses the same settings as replay; dispatcher also requires the silo and OpenFGA
binding. Shutdown aborts readers, stops jobs and closes connections.

## Private memory and survey directories

Fresh secondary settings create separate mode-0700 `personal-keys` and `memory-keys`
inside the claimed slot. `PERSONAL_KEY_DIRECTORY` is saved in `server.env` and
`dispatcher.env`. `MEMORY_KEY_DIRECTORY` is saved in both and `projection.env`.
The memory worker is required on secondary slots. HTTP, projection and cleanup
therefore use the same revision keys and permanent deletion markers.

Caller-supplied paths must match these fixed locations and already exist. Startup
checks ownership, permissions, access and real paths without changing existing
permissions or contents. Restart refuses lost directories or changed settings.
It preserves encrypted survey values, revision keys and destroyed-key refusal.
Models receives only its listed files, conversation keys, provider credentials
and working directory; it cannot mount either private directory through their parent.
The secondary stub's match-count credential lives in `models/model-managed-stub`.
Computers receive neither private directory. Native memory remains disabled.

Before bootstrap or join, startup registers the fresh handler manifest using the
same subscription list as dispatcher. A changed manifest refuses startup without
resetting its checkpoint, jobs or receipts. Existing slots need stopped-services
configuration and the [handler upgrade/backfill](../../apps/ops/README.robot.md#handler-subscription-upgrade):
prepare the two owned directories, update the three environment files, then run
that procedure with the same dispatcher settings. Existing stub slots also move their
`model-managed-stub` file into `models/` while services are stopped. Do not use a reset
as an upgrade.

The owner's optional memory wiring remains unchanged: `MEMORY_KEY_DIRECTORY`
enables its memory worker and HTTP reads; without it reads remain unavailable.

Part of #94; survey custody also supports #101. Filesystem/configuration and service
fixtures cover refusal, membership delivery, human HTTP, restart, deletion and safe
logs/receipts. Fresh live qualification is NOT RUN. Chart volumes/mounts and its
memory worker remain the next split under #15, NOT RUN. Neither feature is complete.

## Daily fresh run

`daily-fresh-run.sh` fetches `origin`, checks out `origin/main` detached in
`~/dev/daily-fresh`, and runs `npm ci` only when `package-lock.json` has changed
since the previous run. It then starts `daily-fresh.sh` from that checkout.
The install script copies this launcher to `~/.opencrane/daily-fresh/run.sh`.

`daily-fresh.sh` claims a secondary id using `claim.sh`, then runs `up.sh --fresh`
with that id. Secondary model services use the local stub. The run makes no paid
model calls. An EXIT trap calls `down.sh --id` with only the id returned by the
claim, after accepting only 1 or 2. A failed startup still reaches that cleanup.
Each invocation replaces an inherited attempt with `nightly-<UTC time>-<UUID>` in
`P4_JOURNEY_ATTEMPT`. It clears inherited real-provider settings, `MODEL_KEY_FILE`
and `DEMO_ALLOWANCE_CENTS` before any child starts. No paid key is read.
The narrow group checks run with the stand-in and never change providers or owners.
A read-only tool fixture includes its action, consequence and safe argument fields.
The core journey selects Allow for that tool and Block for the write tool, using the
saved catalogue revision and review digest. The review must return HTTP 200. A 409
stops the journey; it is never treated as a saved review. The focused regression in
`journey-tool-policy.test.ts` uses the same review validator as the API, without services.
The first and later group sends each wait for HTTP 200, then require the sender’s
message to appear within two seconds. This includes the time taken to apply its saved
row. Their existing receipt rows record `firstDisplayMs` and `laterDisplayMs`.
A failed or unfinished group-chat assertion fails the journey. Before cleanup, nested
receipts and pictures from this attempt are kept under the private failure folder.

If `claim.sh` cannot return an id, the script records `SKIPPED` with the reason
`no free slot` and exits successfully. Every run adds one UTC line to
`~/.opencrane/daily-fresh/ledger.md`. The line records the checked-out source
commit, result, failed step, duration and attempt. On failure, it copies `last-error.log`,
`failure.log`, the last 100 lines of each other process log, and any journey failure
screenshots into a folder named for that attempt before `down.sh` removes the
stack files. Before writing a log, `sanitise-evidence.mjs` replaces known slot
passwords, generated environment secrets, private keys and the supplied
`ZITADEL_KEY_FILE` value with `[REDACTED]`. It also removes URL credentials,
bearer tokens, authorisation headers and values with sensitive setting or JSON field
names. Secret files are read only by the sanitiser. A failed sanitisation writes
only `Log withheld: sanitisation failed.`. It skips `zitadel-*` files. The receipt line names that folder. The
directory is mode 0700; the evidence files and ledger are mode 0600.

The user service is `opencrane-daily-fresh.service`; its timer is
`opencrane-daily-fresh.timer`. The timer runs daily at 03:17 UTC with
`Persistent=false`, so a missed run is not replayed after login. Install or update
both units with `infra/dev-stack/install-daily-fresh-timer.sh`. That script copies
the units to `~/.config/systemd/user/`, reloads the user manager and enables the
timer immediately.

## Local credentials and access

Generated files live in `~/.config/opencrane/dev-stack/` (directory 0700,
files 0600), or a dedicated `DEV_STACK_DIR` outside the repository. Never print,
copy into the repository or share these files. Logs and PID records live there too.
The generator reuses the test fixture's CA/certificate/NKey issuer, with 30-day
certificates. Use `--fresh` to replace expired credentials and disposable data.
These local files stand in for a secret store; production lease rotation is not
qualified here. The NATS container mounts only its certificate/key and CA public
certificate, never client seeds or the CA signing key. Host processes receive
only their settings, although the host account can read all its own files.

Tailscale Serve provides `https://<machine>.<tailnet>.ts.net/org/integrations`
(on this box, `https://ocn-dev.tail00285e.ts.net/org/integrations`). HTTPS proxies
to Angular, which forwards `/api`, `/auth`, `/members` and `/ws` to the server.
Only tailnet devices allowed by the tailnet policy can connect. No Funnel is used.
The stack refuses to overwrite an existing Serve configuration it does not own;
`down` removes the stack's HTTPS service.

## Zitadel sign-in

The stack uses `https://weownai-oidc-8dwlat.eu1.zitadel.cloud` with the
[non-secret configuration](zitadel.json). Only **OpenCrane 2 Dev** is managed:

| Resource | Name | ID |
| --- | --- | --- |
| Organisation | OpenCrane 2 Dev | `393311211338337681` |
| Project | OpenCrane 2 Dev | `393311211539664273` |
| OIDC web app | OpenCrane 2 Dev Web | `393311211707436433` |
| Client | OpenCrane 2 Dev Web | `393311211707501969` |
| Human owner | opencrane2-dev-owner | `393311211875208593` |
| Human member | opencrane2-dev-member | `393311212596681804` |
| External owner identity | existing WeOwnAI user | `378127409465593948` |

The owner has `ORG_OWNER` in this organisation. OpenCrane product permissions
come separately from invitation/join events and OpenFGA, never OIDC roles.
For a packaged fresh check, `zitadel-setup.ts --read-only` checks the existing
secondary app and four test users. It creates local settings and copies the
slot's saved credentials, but refuses missing provider resources instead of
creating them. The package runner uses this mode and makes no provider writes.
The app uses code + S256 PKCE and client-secret POST authentication, with redirects
`https://ocn-dev.tail00285e.ts.net/auth/callback` and
`https://ocn-dev.tail00285e.ts.net/` after logout. The server pins the resource-owner
claim to this organisation, requesting `urn:zitadel:iam:user:resourceowner`.

Every owner `up` runs `zitadel-setup.ts --restore-owner-app` under the shared
Zitadel setup lock. This idempotent guard restores development mode to `false`
and permits only the two owner HTTPS URIs above, preserving other OIDC settings.
The same command can repair the pinned owner app without starting services or
reading owner credentials; its output contains only ids and before/after redirects
and development mode. It requires the management PAT via `ZITADEL_KEY_FILE`
(default `.keys/.zitadel-key`), as secondary setup does.

The setup adds one role-free external user grant for subject `378127409465593948`
to the OpenCrane project. It does not create or change that user, grant the project to
the WeOwnAI organisation, or change either organisation. The login request remains
unchanged: the resource-owner scope returns each user's own organisation, so it does
not need an organisation hint. The server normally requires the OpenCrane organisation
claim, but the dev environment allows this exact issuer and subject; all other subjects
remain pinned. OpenCrane roles still come only from events and OpenFGA.

Each `up` also runs a dev-only owner bootstrap after the projections and dispatcher
start. Through the command NKey it conditionally appends `member.invited` and
`member.joined`, binding that issuer and subject to owner member `jente-rosseel`.
Existing stream state is checked first, so plain and `--fresh` runs do not duplicate it.
This dev-only bootstrap for the privately configured owner test user remains in place. Production installs
use the [one-time token command and claim screen](../../apps/server/README.robot.md#first-owner-bootstrap-12),
which refuse a silo that already has an owner. Dev exceptions for external
identities do not apply to the token claim; its user must belong to the configured
organisation. Ownership transfer is a separate feature (#24).

For a fresh secondary token qualification, set `DEV_OWNER_BOOTSTRAP=0` on
`up.sh --id "$stack_id" --fresh`. This skips the dev owner events and automatic
member-seeding journey, and sets the server's `BOOTSTRAP_TOKEN_FILE` to the
secondary directory's `bootstrap-token.json`.
Generate that file with the installation command after startup. The override
only applies to secondary stacks; the owner stack always keeps its bootstrap.

To rerun the setup, with `.keys/.zitadel-key` available locally:

```sh
flock "/tmp/opencrane-dev-stack-$(id -u).lock" \
  node --experimental-strip-types infra/dev-stack/zitadel-setup.ts
```

The script searches by exact organisation name, checks the recorded ID, and
scopes all management requests to that org. It creates missing named resources
and reuses existing ones, including the one external user grant. It does not read or
change the external user. It does not rotate an existing client secret or password;
missing secret files fail closed. The PAT is read only into an Authorization header,
never printed or passed in argv. No other organisation or instance setting is changed.
The script uses the documented [Zitadel management API](https://zitadel.com/docs/apis/resources/mgmt).

Private files under `~/.config/opencrane/dev-stack/` (0600):
`zitadel-client-secret`, `zitadel-owner-password`, `zitadel-member-password` and
`zitadel.json` (user IDs, login names and password paths). `auth.env` references
the client secret by `OIDC_CLIENT_SECRET_FILE`; the launcher reads it and uses
`libs/auth`'s existing environment-variable indirection. Neither the PAT nor test
passwords are supplied to the server. Run setup before first bring-up. A different
checkout must first stop the old stack and deliberately transfer `stack-owner`;
normal scripts continue to refuse a foreign owner marker. Feature tasks use secondary ids instead.

Open `/` on the tailnet URL and choose **Continue with single sign-on**. Credentials
are entered only on Zitadel. **Sign out** submits a native form POST. The server
clears the OpenCrane cookie and sends a 303 to Zitadel with the encrypted session’s
ID token in the `Location` header only. Zitadel signs out **all accounts in that
browser**, returns home without a chooser, and the next sign-in requires credentials.
Zitadel may first ask which remembered account to use on that next sign-in.
The ID token is never returned in JSON or read by page JavaScript. Email-link delivery is not qualified; its shared state
says unavailable, and no sent-email screen or lockout count is invented.

The journey signs in as both real users in separate Playwright browser contexts
at 390px and uses their actual encrypted cookies for HTTP and WebSocket requests.
It refuses hostile/missing logout Origins and requests without a session. It checks
an empty 303 body and probes manual/follow fetch, XHR, the DOM and page cookies for
ID-token exposure. Native keyboard sign-out returns without a chooser, removes
the OpenCrane cookie and is followed by a successful sign-in requiring credentials.
The five process logs are checked for the current ID token without printing it. Dev-only bootstrap
invitations bind these subjects to stable member IDs; they do not define the
production first-owner policy. Each run adds a new invitation/join and MCP row.
Wrong-org and expiry checks run another real server on temporary loopback ports:
its pin differs from the generated user's real token org while the owner's exact
allowlist entry remains configured, or its session lasts two seconds.
Only those browser auth requests go to the probe. No other cloud org is accessed.

An explicit diagnostic fallback remains for an unreachable issuer only:

```sh
DEV_STACK_OFFLINE_FALLBACK=1 node --experimental-strip-types infra/dev-stack/journey.ts
```

It checks discovery reachability, uses minted five-minute **dev-only** cookies,
prints **FAIL sign-in** and exits non-zero even if the service checks pass.
`up.sh` and `journey.sh` always use real login; they never silently take this path.

For secondary bring-up, `zitadel-setup.ts` checks organisation
`393311211338337681` and existing project `393311211539664273`. Under a shared
setup lock, each id creates or reuses its own app, `OpenCrane 2 Dev CI <id>`, and
four users named `opencrane2-dev-ci-<id>-<role>`. The roles in the names are
owner, member, without-assistant and wrong-account.
The owner app and users are never modified, and no owner credentials are read.
Secondary users need no Zitadel administration role; product roles come from events.
Each secondary app permits only its id's exact callback and logout URIs from the
table above, with no globs. Development mode allows HTTP, as required by
[Zitadel’s app settings](https://zitadel.com/docs/guides/manage/console/applications-overview).
Existing secondary apps with unexpected redirects are refused without mutation.

The secondary app secret and randomly generated user passwords persist in
`~/.config/opencrane/dev-stack-ci-<id>/` (0700), with files at 0600. Setup copies
only those credentials to its disposable secondary directory (also 0600), and
configuration uses the secondary client ID. `down --id` removes the disposable
stack but retains these private credentials and cloud identities for reuse.
Missing retained credentials fail closed; setup never rotates existing secrets.
No other organisation, project, grant or instance setting is changed.

## Qualification

The journey uses running services, never mocks: an HTTP join reaches SQL and
OpenFGA while an authorised WebSocket is subscribed; seeded `mcp.*` events produce
typed admin API rows; anonymous and member access are refused; members and MCP
catalogue replay verify online. The joined member also reaches a Ready gVisor
computer; native suspend/resume and a deleted Pod retain a file on its PVC. It
also fetches the web page over tailnet HTTPS.
Each invocation adds invitation/join events for the two test members and a new MCP row;
fresh runs remove this local business state.
The typed integration-row fixture registers a hosted image reference without an
installation request. Its per-call credential contract needs no startup credential.
It seeds discovery, saves the exact tool review through the
Owner API, and records legacy publication. No container starts and no tool is called.
The existing remote watcher selects only remote registrations, so it cannot invalidate
this display fixture. This check does not qualify remote discovery or hosted installation.
`apps/server/test/journey-integration-fixture.test.ts` records the old remote fixture's
publication followed by failed checks, then requires the current fixture to remain Ready
after the real watcher runs. It uses disposable NATS and PostgreSQL services.
Failure exits non-zero. Private logs identify a failed stage without printing
credentials. `status` reports the host processes, Compose and Tailscale service.
The owner's own browser sign-in remains a manual check and is **NOT RUN** by these scripts.

### Organisation browser checks

`journey.ts` calls the groups-only checks in `browser-phase4.ts` and
`browser-group-chat.ts` after the existing
browser checks. Both modules reuse the signed-in owner and member pages. The group
chat check creates a conversation from the To line with two colleagues, checks the
mode before the first message, and sends ordinary messages to each member. It waits
for earlier computer starts to finish, then counts AI, computer and budget events
around those sends. Synthetic colleagues use the existing event fixture and
`personalAssistant: none`; they need no personal computer for group messages.
This leaves room for the demo assistant inside the six-computer slot limit.
It adds a third seeded member and
checks that earlier messages stay hidden from that member. The check also removes a
member, asks another member to leave, and records how quickly each screen clears.
Removal observers start before Remove. Their zero is the browser's removal request event,
which starts before the server can save removal. The receipt records milliseconds for
`removalSent`, `removalAccepted`, `removalSaved`, `accessStreamUpdated`, `liveFeedClosed`,
`pageCleared`, `historyRefused`, `fileRefused` and `ownerList`. The HTTP response and the
saved-event observation stay separate. Saving and updating access are one event append
to `participation-*`; both timings are when the journey reads that saved event.
Page and saved-event observations are upper bounds, with 20 ms polling plus request time.
The live-feed time is the observed close of the connection open when removal is sent;
a previously closed connection cannot satisfy it. A missing observation is `NOT RUN`
and fails the check. Access observations must finish within two seconds of sending.
The Owner list must update within its separate ten-second limit. The removed browser
has a ready conversation WebSocket before removal. The next history and file-list reads
start after the successful response and must return 403.
The file route already returns 403 for a group chat before removal; the receipt records
that baseline. Its later refusal does not qualify revocation of previously readable files.
This people-only chat has no computer viewer or pending approval, so those checks are
not qualified by this journey.
`group-removal-timing.test.ts` uses a fake clock to keep a slow Owner list independent
of the removed page and API reads, and to refuse a page that clears after two seconds.
It also fails an unreadable Owner list. `browser-group-removal.test.ts` checks that a
700 ms response cannot hide a 2,400 ms page clear, and that a replacement connection
must close even when an earlier connection has already closed.
It checks the long-name and no-match picker states, refuses an unauthorised add, and
refuses a people-and-assistant choice without saving a conversation. It stops the server and conversation worker for an offline replay, then restarts both
and checks server health directly. Each health read gets the time left in the two-minute
startup deadline as its abort timeout. Connection failures and HTTP 502, 503 and 504
allow another read. Other HTTP failures stop the journey immediately. Replay must
keep the group mode and participants.

The shared-assistant check adds a model grant to the disposable event store so the
group can create an assistant. The member starts a private session with it. The direct
chat sends one message each way and reads the conversation stream to check message
order. The direct checks count model admission, computer and budget events before and after
the exchange, so they also run with real providers. Both chat checks read again for
up to fifteen seconds when a saved change moves the list (409) or is still applying
(425). Other HTTP failures stop the check; no write is repeated.

The separate full browser check, excluded from nightly and rehearsals, saves the text
`journey-placeholder-not-a-provider-key`. It is a
fake value, never a provider credential. The check confirms that the input clears and
that the text is absent from the page, browser storage, provider events and process
logs. The local server keeps the key in a private folder inside the disposable stack,
outside the event store. Stack cleanup removes that folder. It does not ask the provider
to answer. Each assertion is written to
`$DEV_STACK_DIR/p4-journey/<attempt>/receipt.json`. Screenshots sit beside it.
Set `P4_JOURNEY_ATTEMPT` to keep each run apart. The group chat receipt is part
of the same JSON file. Its screenshots are saved in the `group-chat/` subfolder
at 1280px and 390px. Public copies are checked for readable emails before committing.

The spare stack allows six computer pods and disks, with up to 3 GiB of memory
and 6 GiB of disk requests. The sixth place lets a saved-data repeat start a new
shared assistant computer while keeping the previous run's data.

The manual ownership check uses product commands to make the signed-in test account
the sole Owner before the ownership screen opens. The separate owner test user stays
in the silo. The browser checks appointment, step-down and the former owner’s Member
role, then checks the last-owner refusals. Product commands restore the test roles
for the saved-data repeat. Separate member
disks and browser profiles are not built. A real provider answer needs a paid call;
the check records it as **PAID / NOT RUN** and sends no request.

Run the repository gates with the existing control database:

```sh
npm run lint
npm run typecheck
npm run check:events
PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres npm test
npm run build -w apps/web
npm run test -w apps/web -- --watch=false
node --experimental-strip-types --test infra/dev-stack/*.test.ts
npx tsc -p infra/dev-stack/tsconfig.json
shellcheck infra/dev-stack/*.sh
infra/dev-stack/up.sh --fresh
infra/dev-stack/up.sh --fresh
npm run visual:screen-p4-19-signin
ss -ltnp
```

Compare listeners with a snapshot from before bring-up: no new `0.0.0.0`, `*`
or `[::]` listener is allowed. Existing host SSH is outside this stack.
See [sign-in evidence](../../docs/process/signin-evidence.md) and [the original evidence receipt](../../docs/process/dev-stack-evidence.md) for results
and conditions not qualified by these local journeys.

## Phase 2 model gateway

`up.sh` starts the model decision and pinned agentgateway binary, budget projection,
settlement handler and a loopback-only scripted SSE provider. It derives public
JWKS from the same lifecycle signing key and supplies the same `TOKEN_ISSUER`.
The decision process only reads the public keys. The dev stack always sets
`MODEL_UPSTREAM=127.0.0.1:43003` and uses a disposable placeholder key; it neither
loads `.keys/.openai-key` nor calls OpenAI.

Every `up.sh`, including `--fresh`, runs the idempotent model grant migration
with the command connection and silo id before decision services start. A
repeat startup stops the server, dispatcher and model services first to keep
event writers out of the migration. The journey checks existing model grant
history and waits for new member/assistant grants in OpenFGA before chat.
Older silos still need the controlled OpenFGA and dispatcher subscription
upgrade described in the [ops instructions](../../apps/ops/README.robot.md#model-grant-upgrade).

The joined member's Ready computer receives a lifecycle turn credential. The
journey installs it over the private control socket, then runs as the Codex UID
through the authenticated local proxy, k3d relay, model gateway and decision.
It asserts a completed stub response and the turn's `budget.reserved` event.
Unit/integration gates additionally prove expired, pre-resume, pre-loss and
mismatched computer/generation credentials cannot reserve money.

Ports 43001–43003 are loopback-only. agentgateway 1.5 binds 43000 on all interfaces;
startup first installs a dedicated IPv4/IPv6 firewall chain allowing only loopback,
Tailscale and the private k3d bridge. Shutdown removes that chain after stopping
the gateway. No public interface or Funnel path is permitted.

The relay lives in `opencrane-dev-gateway`, outside the computer admission namespace.
A dedicated NetworkPolicy permits only that namespace's gateway Pods on port 3000;
the computer uses its Service IP without DNS egress. Startup provisions both and
sets `computer-runtime` automatically. The relay has no credential. Existing
handler subscriptions need a controlled rebuild when introducing `settle-budget`;
the fresh run creates them from the combined catalogue.

See the [model integration evidence](../../docs/process/models-evidence.md) for
fresh/repeat journeys, owner-stack restoration and unqualified conditions.

## Browser chat qualification

The joined member opens **Open workspace**, sends through the composer, observes
streamed stub text, reloads and reads the saved answer. A second turn is stopped
mid-stream and its partial text survives reload. Both 1280px and 390px use real
sign-in; live screenshots go to `docs/design/chat/live/`. The journey records
first-token and completion times, including a message sent to a suspended computer.
The stub spaces deltas by 500ms
so Chromium can observe intermediate renders. For the journey’s cancellation
prompt (`Say hello again.`), the stub pauses for up to 30 seconds after its first
delta, ending the wait when cancelled. This makes the real browser Stop check
predictable under concurrent load; the same partial-text assertion still applies. The overall journey timeout is fifteen minutes, with 120 seconds for event and
computer readiness. No OpenAI credentials are read.
The stub fixture sets a 4,000-cent daily ceiling through a budget event so fresh
and warm journeys fit alongside the worst-case reservations retained by Stop.
It does not invent usage receipts or release uncertain reservations.
The receipt is [chat UI evidence](../../docs/process/chat-ui-evidence.md).

Secondary journeys also prove monthly budgets through the real owner and member
sessions. At 1280px and 390px, the owner saves paying-group and assistant ceilings
in Spending (`/org/spending`), after **Spending loaded**; each zero-cent ceiling
refuses a stub chat call with an explanation retained after reload and no reservation. Repeated default-group
migration preserves existing ceilings without another installation event.
Screenshots for fresh and repeat runs go to `docs/process/p3-13-live/`. The journey
restores usable group and assistant ceilings before the next plain startup.
It also sets the daily safety cap to 5,000 cents through the owner UI, retaining
unconfirmed Stop reservations while leaving enough headroom for the repeat run.

Secondary journeys also read each member's completed stub turn in Action history,
with the permission decision and observed outcome shown separately. The owner reads
safe organisation changes; another joined member is refused private history, and
members are refused organisation history. The organisation-history check follows older pages to find the saved MCP
publication, checking each page for private canaries. Newer membership grants can
fill the first page before this check starts.
The browser waits for **History loaded** on each page before checking for the
publication or an **Older history** button.
Owner/member sessions use real Zitadel
sign-in; the extra member uses a dev-only signed session to test resource authority.
Both views and the refusal screen are checked at 1280px and 390px. Private chat,
query, conversation-id and bearer canaries must be absent from live process and
model/gateway logs. Fresh/repeat screenshots go to `docs/process/p3-19-live/`;
the [audit receipt](../../docs/process/p3-19-audit-evidence.md) records qualification.

## Browser approval qualification

Every journey also configures the credential-free `approval-journey` MCP route
against the local recording stub. Calls use `mcp-name` and `params._meta` with
camelCase version/capability keys, the signed thread id and a stable call id.
It seeds saved tool definitions with matching digests, a fresh five-minute catalogue,
grants and an active tool turn through events. Discovery must leave every tool blocked
and unreviewed. The fixture reads the saved events for the current review revision.
The signed-in owner saves the exact Ask review through
`POST /api/org/integrations/:serverId/review` before publication.
The later integration-list check uses the same path to save Allow for its read tool
and Block for its write tool. The gateway is called with lifecycle credentials.
The stack gives the recording stub a new `MODEL_STUB_MCP_GENERATION` and the saved
catalogue digest at startup. It puts the same generation in the configured MCP route,
with `revisionHeader: 'x-opencrane-mcp-revision'`. The stub checks both values just
before recording the call. Its digest comes from the same saved test definition as
the journey. Missing or changed headers return 409 with no recorded effect. Run the focused check with
`nice -n 10 node --experimental-strip-types --test infra/dev-stack/model-stub.test.ts`.
The signed-in requester sees the 8g card, approves in the browser and retries the tool once.
A refused or ambiguous decision submission uses Check status before a safe retry,
with at most three submissions and three status reads per submission; the journey
records the submission counts. A failed status read never authorises a retry.
The stub must record exactly one call with unchanged bytes and an allowed decision;
a second retry and a denied call must produce no additional upstream effects.
Requested, approved, used (outcome unknown) and denied cards survive reload at
1280px and 390px. Screenshots go to `docs/process/p3-2-live/`.
The approved card says **Approved by you** and **Not used yet**. The journey checks
those words before retrying the tool. A failed approval step saves
`approval-failure-<width>.txt` and `approval-failure-<width>.png` in the selected
stack's private directory before cleanup closes the turn. The text includes the
browser error and the card's accessible names, which screen readers use.
This qualifies browser approval and gateway admission, not native Codex MCP
continuation or an external tool's final outcome. No OpenAI call is made.
Approval tools explicitly cost zero; the journey uses the stored installation
paying group. The monthly-budget journey above owns the test ceiling changes.

## Browser desktop qualification

The chat journey opens **Watch your computer** from the real member's conversation
at 1280px and through the session overlay at 390px. Without a shared-desktop grant
it shows **Unavailable**; a dev-only grant event then allows viewing. The viewer
decodes the deployed computer's 800×600 framebuffer through the selected stack origin, the
generated Angular proxy and the server's `computer-lifecycle` service account.
A known window is fixture activity to make pixels recognisable; a real Codex turn
also completes through the stub provider while the viewer is open. Revoking the
grant closes the socket, clears pixels and records the stop audit. Keyboard
opening, Escape, fit/actual-size and 44px targets are checked. Screenshots and
receipts go to `docs/process/live-view/conversation-*`.

For ten instrumented live-view repetitions on a claimed secondary, run
`node --experimental-strip-types infra/dev-stack/live-view-repeat.ts <output-directory>`.
The directory defaults to `docs/process/i77-live-view`; choose a new directory
to retain an earlier batch. Each run records safe server stage/lease timings
and browser admission/connection milestones. `replyTiming.firstDeltaMs` measures
the time from the browser's message POST to its first received `agent.message_delta`
frame. A null value means the measurement was not reached before the run ended.
No message or reply text is retained by this observer.
Run `python3 infra/dev-stack/live-view-resources.py <output-file>` during a batch
to sample RSS, file descriptor counts and host CPU pressure every five seconds.
It checks the selected secondary belongs to this worktree. It uses `sudo -n ls`
to count descriptors for container processes with another uid. It records missing
readings as errors. V8 heap used is unavailable because the server has no heap endpoint.
See the
[diagnostic receipt](../../docs/process/i77-live-view.md#safe-timing-records)
for field meanings and collection limits.

For screenshot qualification on a claimed secondary, run
`node --experimental-strip-types infra/dev-stack/screenshot-journey.ts fresh`
after `up.sh --fresh`, then use `repeat` after plain `up.sh`. Real Zitadel sessions
capture the deployed desktop, open the saved image from the conversation and panel,
and reload at 1280px and 390px. Repeat also reopens the fresh run's screenshot
when capture passed; otherwise it records that persistence check as NOT RUN.
A signed-in non-participant with a desktop grant is refused viewing, capture and
file access. Receipts and screenshots go to `docs/process/p3-18-live/`.

## Browser upload qualification

`upload-journey.ts` accepts the file-list API's HTTP 425 while the files projection
is applying. It retries within its existing two-minute delivery limit. HTTP 200
still requires exactly one clean upload; an empty list remains a failure.

`demo-prepare.ts` also retries HTTP 425 with `{status: "applying"}` within its
existing two-minute delivery limit. It waits for the saved PDF to appear as delivered
and does not upload it again. `demo-prepare.test.ts` checks two applying replies after
a lost upload reply, followed by delivery, while keeping the exact write assertions.

The browser starts a draft, attaches `project.pdf` through the native file picker,
waits for delivery, previews the promoted original and asks for its project code.
The question does not contain the answer. The stub uses the inline MarkItDown text
when it contains the requested fact. Otherwise it requests a file read through `exec`
and answers only after Codex returns the fact. A completed read takes priority over
the original inline text. An unsuccessful read ends with a failure rather than
inventing the fact or requesting the same file repeatedly. The HTTP upload proof
always requests the file read, even when inline text is present. The journey also checks
reload, EICAR/type/size refusals and text/image previews, at 1280px and 390px.
It drops the first upload response after the server handles it, clicks Retry and
checks that only one attachment exists. The size check selects a real sparse file
through the native picker rather than copying 20 MiB through Playwright.
If a response is lost, the journey clicks the shipped Retry control at most twice
with a one-second pause. Known type, size and malware refusals are never retried.
Full Chromium supplies its native PDF viewer; headless-shell cannot render PDFs.
Screenshots are `docs/design/chat/live/upload-*.png` and `preview-*.png`.
The [upload receipt](../../docs/process/upload-evidence.md) records the results.
The ordinary journey never uses a paid provider.
Its login fixture retries Chromium `ERR_NETWORK_CHANGED` at most twice; recovery
after submitted credentials must still have a valid server session, followed by
the normal identity, organisation and cookie assertions.

`model-stub.test.ts` sends the computer's real `turnInput` output to a disposable
HTTP stand-in. Unavailable and empty inline text must request the converted file.
A later tool result supplies a different project code, which must appear in the
completed answer. A failed read must finish without repeating the request.

### PDF answer investigation, 22 October 2026

The retained failure came from source `db18a7bf1882515421a8955010e898183fcb183f`,
attempt `nightly-20261022T211505-1d48d147-b640-4a88-9e05-da853665efd4`.
Its private logs and `chat-failure.png` are under `~/.opencrane/daily-fresh/` in
that attempt's directory. The picture shows “PDF reading failed.” and “Done”.
The page had updated; it was waiting for the expected answer rather than a late reply.

The files worker log records these observations. The intervals include worker
scheduling time and do not separate network delivery from PDF conversion.
The computer acknowledges delivery only after conversion finishes.

| Observation | UTC time | Interval |
| --- | --- | --- |
| Uploaded file | 21:19:57.532 | Start of delivery and conversion |
| Delivered file | 21:20:32.315 | 34.783 seconds after upload |
| Posted question | 21:20:38.044 | Start of the answer check |
| Started turn | 21:20:39.134 | 1.090 seconds after the question |
| Admitted model call | 21:20:43.467 | 4.333 seconds after turn start |
| First reply piece | 21:20:43.805 | 0.338 seconds after admission |
| Completed turn | 21:20:44.708 | 6.664 seconds after the question |

The stand-in treated the attachment preamble as usable inline text. When that
text lacked the fact, it skipped its file read and returned the failure above.
It also preferred the original inline text over a later file-read result.
The exact model input was not retained, so the reason that attempt lacked the
inline fact is unknown. The regression reproduces the same response with the
computer's supported unavailable-text input, without a live stack.
Commit `1d0b9e9ee` contains the failing test before the fix.

A diagnostic fresh start from `9367396af` on claimed slot 1 passed both browser
PDF answers when inline text was available. A disposable Docker computer also
delivered and converted the original PDF and answered from its text. A separate
gateway fixture preserved that text. Those checks do not reproduce the original
missing-text condition. The diagnostic browser run was interrupted after both
PDF answers and its slot was released. Temporary diagnostics recorded only
booleans about the input; they were removed before committing.

The fix changes only the development model fixture. The browser still requires
the expected project code and a completed reply within its existing two minutes.

Qualification: `nice -n 10 infra/dev-stack/daily-fresh.sh`, with the existing
private Zitadel credential file configured. Source:
`267e038bb9b8cf598cacf49de410f6dcbe394855`. Fresh claimed slot 1, free stand-in,
attempt `nightly-20261022T232200-238bd706-cd43-4315-bb24-b449c3adc9c4`.

| PDF check | Delivery and conversion | Question to turn completion | Result |
| --- | --- | --- | --- |
| Browser, 390px | 19.484 seconds | 4.151 seconds | PASS |
| Browser, 1280px | 13.081 seconds | 3.172 seconds | PASS |
| HTTP, forced native file read | 15.839 seconds | 7.389 seconds | PASS |

These intervals use the files worker's timestamps, as above. Both browser checks
progressed past the completed Willow-47 assertion. The HTTP check ran the native
command, checked the answer and progressed to computer suspension. The following
replacement check kept the converted PDF text. Website compilation took 52.495 seconds.

The whole nightly run was **FAIL** after 759 seconds: a later spending check timed
out waiting for the “Budget scope” control in `browser-budgets.ts:50`, called at
line 89. Later group journeys and replay checks were **NOT RUN**. This result does
not qualify the whole demo. The launcher released slot 1 and removed its containers.
Retained sanitised logs are in `~/.opencrane/daily-fresh/` under that attempt's
directory. Its `generated/` folder keeps the journey's changed screenshots and
JSON records; those generated repository files were restored after the run.

Local checks: **PASS** for seven focused stand-in tests twice, all 438 event-security
tests once, workspace and focused strict typechecks, lint including Knip, the
149-type event catalogue, and changelog validation. Checks used `nice -n 10`.
Lint used a 6 GiB heap and reported 24 warnings in unchanged code. The focused
and security tests set the requested `PG_TEST_URL` and need no database. A separate
gateway investigation used a throwaway PostgreSQL container, removed with its volume.
Full root suite and paid-model qualification: **NOT RUN**.

## Budget journey cleanup

Each zero-cent browser check restores that scope in a `finally` block. The calling
journey creates the `budget-journey` group and `team-budget-journey` shared assistant
through the owner APIs, adds the signed-in member and starts private shared sessions
at both widths. It waits for the membership and assistant receipts to confirm their
read tables and access records before opening sessions.
Plain startup reuses the same creation commands and subjects.
Personal assistants are not valid choices in the spending editor.
The journey restores that exact paying group, assistant and global limits after the
budget browser checks, whether they pass or fail. Audit checks finish before budget
setup and change no ceilings. Cleanup uses the authenticated
budget API rather than loading the Spending page. It waits for the budget table to
catch up before the next step. Monthly test limits are 20,000 cents; the daily global
limit is 5,000 cents. It attempts every scope and reports any failed restoration.

## Lifecycle image-update tests

The lifecycle worker upgrades suspended Sandboxes in place. It reads the checked
cluster template and sends one resource-version-checked update of `spec.podTemplate`.
Admission requires the controller to confirm that the Pod is gone. It checks the
exact new template, the named home PVC volume and unchanged metadata and other
spec fields. The worker has no Sandbox delete or PVC write rights.

`apps/ops/test/lifecycle-k3d.test.ts` requires a claimed secondary `DEV_STACK_ID`
of 1 or 2 and checks that this worktree owns it. It creates and removes only that
slot's computer namespace and its three named admission policies. It builds a
second image digest under a slot-specific tag. It uses disposable PostgreSQL
databases through `PG_TEST_URL`. Run it with the rest of that slot stopped.
The owner namespace and configuration directory must never be used.

## Invitation sign-in requirements

The [acceptance API](../../docs/api/members.md#zitadel-deployment-requirements)
requires self-registration off in the silo's organisation, no external identity
providers that assert verified emails, and only trusted admins setting verified
emails. Emails are not unique in Zitadel. Each app must have
`idTokenUserinfoAssertion=true` so its checked ID token includes email claims.

`zitadel-setup.ts` reads the owner app and the selected secondary app to check
this setting. Setup fails with a clear message if it is missing, false or a string.
The check adds no provider write, does not repair the setting and does not touch
external users or other organisations. Tests use an isolated provider fixture;
they verify that a refusal leaves provider state unchanged.

OpenFGA uses its default limit of 100 tuples per atomic write. A new group chat has
at most 97 people, leaving space for its creator, silo and event receipt.

## Gateway control and approval journey

`MODEL_GATEWAY_CONTROL_PORT` is last in the port list: owner 43004, secondary slots
25112 and 25212. It is never published or forwarded. The gateway admits loopback
sources only on this listener. `MODEL_MCP_ROUTES` is no longer supplied.
The approval journey prints `SKIP approval journey: waits for #45 rows 4, 5 and 14`.
It cannot report PASS through the former seeded startup route.

## Managed model calls

Fresh starts with the dev Owner bootstrap run `provider-setup.ts` after server health
and before `journey.ts`. A five-minute dev-only session represents the bootstrapped
Owner, the privately configured owner test user. Setup uses product HTTP routes with the configured Origin:
create OpenAI connection, save random stub credential, check reachability, accept the
quoted model test, enable `modelForTask('chat_turn')` and `gpt-6-luna`, explicitly
select the silo default, drain, then switch on. Every write waits for its receipt.
After enabling models, setup waits up to 30 seconds for `seed-provider-default` to
record the first binding. It then reads that position for the explicit Owner selection.
This avoids racing the scheduled binding; it still makes only one selection write
and refuses any later conflict.
HTTP 425 with `status: access_applying` waits 100 ms and repeats the exact input and
command id, within the request's original 30-second deadline. This applies to reads too.
Malformed or different 425 replies stop setup. A lost reply or HTTP 503 reads the original
command result and never repeats an uncertain write, including when that read is 404.
Other refusals stop startup with only the step and status. A refused fresh setup
needs diagnosis and another fresh start. Product access checks still run on every attempt.
Token-bootstrap qualification (`DEV_OWNER_BOOTSTRAP=0`) skips this setup and the journey.

The server and models share `PROVIDER_SECRETS_DIR`. Startup creates it as the host
user with mode 0700 before either process starts. Secondary models mounts it read-only. Startup copies the pinned gateway binary into
the stack directory and mounts that file alone, so a host tool symlink can point outside the worktree.
The stub reads a separate mode-0600 file and exposes only credential-match counts at
`/provider-counts`: `managed` and `other`. `/journey-counts` keeps its existing response.
The stub supports model-list and non-streaming verification as well as streamed chat.
Provider rows contain no address; the existing `MODEL_UPSTREAM` selects the local stub.

`modelsEnvironment` removes inherited `MODEL_KEY_FILE` settings. Before recorded
switch-on it supplies the local stub file; afterwards it supplies only shared custody.
The stack restarts models after setup and waits for readiness. Repeat starts read
`managedProviderCallsEnabled` before choosing the environment. Default starts make no paid calls.
The [qualification receipt](../../docs/process/p4-22-managed-dev-stack/receipt.md)
records the single-slot qualification. The provider reached ready and switch-on
was accepted. A later-joining member chatted through the explicit default, with no
legacy key-file setting and only managed credentials counted by the restarted stub.
Free reachability admissions do not count as spending; all other unresolved sends
still block switch-on. Twice-fresh qualification remains NOT RUN for PR 5e.

## Hosted MCP namespace rules

`node infra/dev-stack/mcp-admission.mjs <namespace>` installs separate StatefulSet,
Pod and scale policies with fail-closed image parameters. Apply
`mcp-lifecycle-rbac.yaml` in that namespace for lifecycle rights. The caller must
provision `mcp-approved-images`; the lifecycle identity cannot edit it or any policy.
These files are not installed by `up.sh` yet. Part 8b adds quota, network policies
and secondary startup installation. See the [test contract](../../apps/ops/README.robot.md#hosted-mcp-admission).

Pod admission includes `pods/resize` for hosted tools and computers. Computer Pod
resource requests and limits must match the checked sandbox template. The hosted
admission live file covers both policies in disposable secondary namespaces.

## Opt-in real replies

Set `DEV_REAL_PROVIDER_FILE` to the private OpenAI credential file path when running
`up.sh --id 1 --fresh` or `up.sh --id 2 --fresh` on a claimed slot. Only private setup
reads its value and sends it to the existing custody API. The path is not saved in
stack settings or passed to server/models. The provider is named OpenAI demo.
Models and verification omit `MODEL_UPSTREAM`; they use the production OpenAI route.
After switch-on, models has no `MODEL_KEY_FILE`. The local stub is not started.
Only secondary models mounts the host's `/etc/ssl/certs/ca-certificates.crt` file,
read-only at the same path, so the pinned gateway can verify public HTTPS certificates.
The rest of the host certificate directory is not mounted.
Node uses bundled roots and could connect even when the gateway had no trusted roots.
Missing, empty or invalid files fail with a fixed preparation error.

The owner can use `up.sh --id owner --owner-run --fresh` with the same file-path
setting, after the runbook's fresh-install prerequisites are met. Every owner real
start requires the explicit flag, TTY stdin and no `OPENCRANE_FLEET_TASK` variable.
The guard runs before reading or creating the owner directory. Fleet-marked owner
starts are refused even without a real-provider setting, as are all headless owner
starts. Unmarked interactive owner stand-in starts retain their existing behaviour.
`--owner-run` is refused for secondary ids.
Real owner startup skips the stand-in process; startup and status do not require it.
The owner models process already runs on the host and uses its existing certificate store.
The owner command has not been run live; tests replace system commands in a temporary home.

The Compose test resolves both owner and secondary configuration without starting
containers. It checks the exact certificate source, destination and read-only setting,
and refuses certificate mounts on other services. Startup tests use a temporary home
and replacement system commands. They check real-mode eligibility and saved-mode changes
before setup can run. The secondary models test omits required settings so neither
the stand-in nor the models service can start.

Every child in `daily-fresh.test.ts` receives disposable model and Zitadel key paths.
The isolation test supplies synthetic inherited keys whose values match expected log
text. Reading either key changes that text during sanitisation and fails the test.

Setup still uses the product reachability check, exact consented quote, registry models,
explicit default, drain and switch-on. The initial default-binding read waits through a temporary 503 within its existing
thirty-second deadline. A lost write response permits only a GET of the
original command receipt. Recovery requires the expected operation. An absent or unknown
receipt never causes another POST. Incomplete setup stops; repeat startup cannot silently
create another provider or change modes. Keep the opt-in on ordinary restarts. A fresh
start is required to change between real and stub modes. The nightly unsets the opt-in.

The real journey replaces only the stub chat checks. It uses existing sign-in and later
member setup, then four chat turns: arithmetic with streaming/reload, Stop with partial
text/reload, the member's capital-city answer, and an uploaded supplier quote's total and
delivery date. The PDF goes through the normal malware scan and turn input. Together
with provider verification this requests five paid turns. Real startup seeds a maximum
2,000-cent daily/monthly ceiling. Set `DEMO_ALLOWANCE_CENTS` before startup to use a
smaller approved limit, including provider verification. This is not a shared spending counter.
Run only within the owner's shared daily approval. A failure stops the journey without
resubmitting a turn. The receipt in `docs/process/demo-real-model/` records source SHA,
checks and reservation/charge cents; null charges mean an unresolved hold.

## Demo group seed

`DEV_STACK_ID=1 node --experimental-strip-types infra/dev-stack/demo-seed-run.ts`
reuses the bootstrapped Owner and joined slot member, creates two named groups and
one shared assistant, and prints bookmarks. It uses a five-minute development Owner
session and authenticated HTTP commands only. Command ids and payloads stay fixed.
Private `demo-requests` files prevent resubmission after an unknown result; server
receipts remain the source of truth. Missing people are refused before any writes.
The caller must own the stack directory. Owner use additionally requires `--owner-run`,
TTY stdin and an absent `OPENCRANE_FLEET_TASK` variable. These checks happen before
loading owner configuration. Even an empty fleet marker is refused.

`demo-up.sh` requires an explicit secondary id and `DEV_REAL_PROVIDER_FILE` path.
It claims through `claim.sh`, checks the returned id, sets `COMPUTER_IDLE_MS=14400000`,
runs fresh startup and seeds. A mismatched, owner or invalid claim stops before startup
or cleanup. Once startup is attempted, startup or seed failure calls `down.sh` for that
secondary; success keeps it.
It inherits the full startup journey and makes no claim about three-minute duration.
The [owner runbook](../../docs/process/demo/README.md) keeps owner-mode and fresh-install
qualification gates. The timed rehearsal below adds PDF and ceiling preparation.
The seed does not rename existing members or make cloud identity changes.
Tests use `nice -n 10 node --experimental-strip-types --test infra/dev-stack/demo-*.test.ts`.

The launcher tests record startup and cleanup without starting services. They check
that an existing slot survives a request for the other id, unsafe claims cannot reach
startup or cleanup, seed failure removes only the started secondary, and no synthetic
credential value appears in output. The CLI tests use real configuration and session
code with disposable settings and an HTTP fixture. They check id validation before
configuration loads, worktree ownership and the fixed secondary origins.

## Owner startup and automated journey safety

An authorised owner start uses service health, process and listener checks to report
readiness. It does not invoke `journey.ts`. Automated owner journeys are always refused.
The shell launcher, direct stack journey action, main journey, bootstrap journey,
MCP journey, screenshot journey, repeated live-view journey and package chat scripts refuse the owner id
and any `OPENCRANE_FLEET_TASK` marker before configuration is evaluated.
The main journey checks `DEV_REAL_PROVIDER` against the saved mode before setup;
bootstrap and repeated live-view journeys require the saved stand-in mode.

Real starts save real mode after infrastructure and provider checks. Startup remembers
the previous saved mode before a fresh reset. On failure, SIGINT or SIGTERM it stops
processes and Compose services launched by that attempt, removes any namespaces and
HTTPS handler it created, and restores that mode. It attempts each cleanup step even
if another fails. Existing containers are excluded from cleanup. It keeps the restrictive
model firewall rules. A fresh reset still erases data; restoring the mode cannot undo it.
The [demo guide](../../docs/process/demo/README.md#owner-run-switching-the-real-model-off)
documents stopping services and making a fresh stand-in start.

`stack-start.test.ts` runs the real startup control flow with fake configuration,
processes, service adapters and network calls. It checks readiness, deferred mode saving,
failures after saving and switch-on, and both interruption signals. Previous modes
include absent, `0` and `1`. `journey-refusal.test.ts` records configuration evaluation
and stops before external calls. It checks all automated entry points and detects
removal of the non-start owner flag refusal, duplicate flag check and secondary owner
flag refusal. CI runs both files with the existing Node fixtures. These are local
source checks, not live qualification.

## Timed demo rehearsal

The command prepares and rehearses an owned real secondary:

```sh
DEV_STACK_ID=1 DEMO_ALLOWANCE_CENTS=700 \
node --experimental-strip-types infra/dev-stack/demo-smoke-run.ts
```

Replace 700 with the confirmed remaining daily allowance, including startup and holds;
it must be an integer from 1 to 2000. The company daily and monthly ceilings both
use that value. No group or assistant ceiling changes. Owner and missing ids are refused.

The command signs in separate browser profiles, reuses the group seed and uploads
`fixtures/supplier.pdf` through scanning into a fixed personal chat. The quote says
EUR 1,234.56, delivery 17 November 2026. Request records and original receipts prevent
unknown writes from being repeated. The PDF list must report delivery before warm-up.
Warm-up sends one short question to each of the personal and shared computers.
Preparation and warm-up sit outside the timed checks and still count as paid calls.

Each warm attempt has a 180-second deadline. It checks completed replies and reload, PDF facts,
preview/download bytes, Stop/reload, live direct delivery, a shared reply, and company
limit refusal/restore. Restoration is attempted even after failure or timeout.
Two attempts capture both browsers at 1280 and 390 pixels after each step;
the member sends at 390 pixels. Failed steps also attempt to save pictures.
Private timings, screenshots and spending records go under the slot's `demo-smoke/`.
Each run saves both previous company ceilings in its own `saved-ceilings.json` before
changing either. Normal completion, failures, SIGINT and SIGTERM restore them through
the admin API. Signals stop new work and close the browser before restoration. The
file is removed only after the API confirms both restored values. If restoration
cannot finish, the next invocation restores saved files before preparing another run.
Keep the run folders until any unfinished restoration has completed. SIGKILL and a
host outage cannot run cleanup; their saved files need that next invocation.

`spending.json` keeps a starting company budget and budget-stream position. It reads
budget events without appending to the store and matches reservations to message ids
submitted by this run's browser contexts. `turns.json` saves those ids without prompts
or credentials. Each recorded call names its reservation, turn, charged cents and
held cents. Unknown outcomes retain the full hold; confirmed unsent calls show zero
charge and hold. Earlier calls and other users' turns are excluded from run totals.
Company totals remain supporting information. Records describe the last observation;
a still-running turn may create further reservations after that observation. A failed
final read marks the record PARTIAL and retains the last known charges and holds.
`timings.json` is written on failures too, including failed warm-up and interrupted
attempts. A warm-up that was never reached is NOT RUN.

Recording fixtures cover preparation failure after raising 100 cents to 700, both
interrupt signals during the limit step, a failed restore recovered on the next run,
and spending and timings after failed warm-up. Separate fixtures reject a failed
step within 180 seconds and successful steps taking longer than 180 seconds. The CLI
fixture refuses configuration loading to prove the secondary id check runs first.
The command does not claim or remove a stack. Use `claim.sh` before startup and
`down.sh --id` after copying the receipt. Live results are in the demo receipt.

## Ten-step demo rehearsal checker

`demo-rehearsal-run.ts` retains the ten-step script used by draft PR #603.
The original was an operator file under `/tmp/demo-final-rehearsal-evidence/`.
On an already claimed, owned real secondary, the command is:

```sh
DEV_STACK_ID=1 DEMO_ALLOWANCE_CENTS=1000 \
node --experimental-strip-types infra/dev-stack/demo-rehearsal-run.ts
```

This command makes paid calls. The allowance must be an approved integer from 1 to
2000 euro cents. Each paid turn first checks charged and held company spending plus
100 cents against it. This is the retained script's check, not a shared spending counter.
The command neither starts nor claims a stack. Missing, owner and invalid ids are refused
before settings load. Each invocation starts a new run; it does not resume paid steps.

The script checks completed replies, scanned PDF, action history, Stop, live direct delivery,
private shared replies, groups and an unopened invite, Models, company limits and change
history, at 1280 and 390 pixels. Step 5 sends from 390 pixels at both widths.
A failure stops later steps, which are recorded as NOT RUN.
Private `demo-rehearsal/<time>/results.json` records each step's result, duration and
sanitised failure message. A screenshot error cannot replace the checker error.
If the company-limit check and its restoration both fail, `reason` keeps the checker's
message and `additionalReasons` records the restoration message. Both remove private
values separately. A restoration failure after a successful check still fails the step.
The existing evidence sanitiser removes known credentials and credential patterns;
failed sanitisation withholds the details. Screenshots mask email addresses, password
inputs, invitation links and provider-key patterns.

Step 8 scopes “Model answered” to the `dev-openai` row inside `oc-models main`. Password inputs and provider-key
patterns are still checked across the page. The other nine steps have no unscoped
`main` locator. The nested-main fixture failed first with Playwright's strict-mode
error: `locator('main') resolved to 2 elements`. It passes after the fix and refuses
missing status, keys outside Models and visible password inputs. Run its fixtures with
`nice -n 10 node --experimental-strip-types --test infra/dev-stack/demo-rehearsal.test.ts`.
The recording fixture runs the real rehearsal and budget helpers with browser and HTTP
substitutes. It checks both failures in `results.json`, the restoration attempt and
the later steps recorded as NOT RUN. Separate checks cover private values in both
errors, failed sanitisation and a screenshot failure alongside them.
Live rehearsal after this correction: NOT RUN.

### Repeated widths and step pictures

Each checker invocation creates a random attempt id. Invitations, personal and shared
chat prompts, direct and group messages, refusal prompts and limit restoration commands
include that id and the current width. The chat screens create fresh conversation and
command ids through their existing controls. The Stop helper accepts the same labelled
prompt; its existing callers retain their original prompt.

The checker opens a fresh draft before the arithmetic and PDF steps. Action history and
Stop use that width's PDF conversation. Direct and group chats start from the new-chat
page. The shared-assistant step starts a new private session, which the limit step then
uses. The existing Acacia group and shared assistant are read and reused, without
changing their members or settings. Models is read only. Company limits are shared:
the refusal still needs the daily cap to equal charged cents, so the cap is not varied
for uniqueness. The existing controls create a fresh save command, and restoration uses
the attempt and width. Both original limits must be confirmed restored before continuing.
The history check retains its existing event matches and twenty-page limit.

Each PASS in `results.json` includes a non-empty `pictures` list. Paths are added only
after screenshot saving finishes. A missing or failed picture fails the step. History
pictures scroll the matching limit and group rows into view before saving. Existing
masking, failure sanitisation and all reply, download, refusal and spending assertions
remain in place.

`demo-rehearsal-repeat.test.ts` runs both widths twice against one recording fixture.
The fixture refuses a duplicate invitation address and checks saved files for every PASS.
It also checks prompts, unique restoration requests and restoration of both limits.
The first run against the old checker failed at phone step 7 with
“Invitation email already exists”. A separate browser fixture puts both history rows
below the first viewport and checks that each row is inside its picture at both widths.
Missing history entries still fail. Run both changed test files with:

```sh
nice -n 10 node --experimental-strip-types --test \
  infra/dev-stack/demo-rehearsal.test.ts infra/dev-stack/demo-rehearsal-repeat.test.ts
```

These fixtures make no paid calls and start no stack. Live qualification remains NOT RUN.

### Audit of all rehearsal steps and the smoke

Part of #569. The shared answer helper waits for loaded history before counting the
existing replies. It selects the next reply by its position before sending. It waits
for Done in that reply's status line, checks every expected fact, reloads and requires the
same completed text. It never waits for a streaming caret. This also prevents an
older answer from satisfying repeated smoke questions in the saved supplier and
shared chats. Stop selects the new reply in the same way. It needs received text
and an enabled Stop button before clicking, then requires the saved partial text.
A reply that finishes before Stop can be clicked still fails that check.

All ten steps were checked for temporary status waits, ambiguous locators, values
shared between widths, dependence on earlier steps and a PASS without a saved picture.
The existing two-width repeat fixture still runs twice. Every invitation, created
chat message and restoration request keeps its attempt and width. Every rehearsal
PASS still requires a non-empty picture list, populated only after saving finishes.

| Step | Waits and locators checked | State, repeated widths and pictures checked |
| --- | --- | --- |
| 1. Arithmetic reply | Select the new reply; wait for Done, expected 437 and unchanged reload text. | Open a fresh draft; use the attempt and width in the prompt; capture the owner. |
| 2. Scanned PDF | Wait for Ready, completed facts and Preview ready; check the viewer page and exact download bytes. | Open a fresh draft and upload once; keep this width's conversation; capture upload, preview and reply. |
| 3. Action history | Exact allow and Success text may repeat, so select the first matching record deliberately. | Open the history for this width's PDF conversation; capture the owner. |
| 4. Stop | Remove the caret wait; select the new reply, require received text and click its Stop button. Keep stopped status, non-empty text, reload equality and no Reply failed. | Use this width's PDF conversation and labelled prompt; capture the stopped reply. |
| 5. Live direct message | Select the colleague by exact name rather than substring; require both unique messages on the receiver. | Open new-chat controls; send from the phone; capture sender and receiver. |
| 6. Private shared reply | Wait for the saved private session, then the new completed Paris answer and unchanged reload text. | Start a new private session for each width; capture the member's answer. |
| 7. Group and invite | Use exact colleague names; retain group-mode, message-delivery and created-link checks. | Open new-chat controls; use separate message and invitation values; capture group chat, group and unopened invite. |
| 8. Models | Scope Model answered to the dev-openai provider row; retain password and key checks across the page. | Read the prepared provider without changing it; capture the owner. |
| 9. Company limit | Keep saved-budget status, current-prompt refusal before and after reload, and unchanged charged and held cents. | Use this width's private session; restore both previous limits even after failure; capture refusal before restoring. |
| 10. Change history | Keep both event matches, explicit first matching rows and the twenty-page limit. Slow older pages still wait for rows. | Read the prepared group and saved limit events; scroll each match into view and save both pictures. |

The links between steps are deliberate: steps 3 and 4 use step 2's conversation,
and step 9 uses step 6's private session. A failure prevents all later steps and
widths from running. Neither can reuse a prior width's conversation after a failed
setup. The demo's prepared group and assistant are read without changing membership.

The smoke was checked separately:

| Smoke step | Checks and isolation |
| --- | --- |
| Arithmetic | New completed reply, 437 and exact reload text in the prepared supplier chat. |
| PDF | New completed facts, preview page and exact download bytes from the prepared attachment. |
| Stop | New reply's received text and Stop button, saved stopped status and unchanged partial text. |
| Direct delivery | Exact colleague selection; separate random message values and new-chat controls. |
| Shared reply | New completed Paris answer and reload text, even when the question repeats in a saved private chat. |
| Company limit | Unique refusal and restoration ids; current refusal before and after reload; unchanged spending and restored limits. |

Every smoke step awaits pictures from both browsers before it can pass. The existing
three-minute limit still fails an overlong smoke and prevents later work after expiry.
Preparation deliberately owns the supplier attachment and private-session URL; the
smoke does not rely on a rehearsal having run first.

The completed-reply browser fixture failed first on the old caret wait. Other small
fixtures reject an old correct answer without a new reply, incorrect facts, an
unfinished answer, changed reload text and a provider that has not answered when another provider has.
A reply saying Done in its prose without a completed status failed first by wrongly passing.
The duplicate-provider fixture also failed first with a strict-locator error.
Colleague fixtures distinguish name prefixes and refuse duplicate exact names.
Stop is checked with a loading composer and no caret. History pagination takes
longer than the old fixed pause. Pictures are checked for all six smoke steps at
both widths, and a failed member picture fails every otherwise successful step.

Run the three fixture files with:

```sh
nice -n 10 node --experimental-strip-types --test \
  infra/dev-stack/demo-smoke.test.ts infra/dev-stack/demo-rehearsal.test.ts \
  infra/dev-stack/demo-rehearsal-repeat.test.ts
```

These source checks make no paid calls and start no stack. Attempt 5 remains NOT RUN
here; the orchestrator runs the fresh live rehearsal after merge.

## Overview details and related procedures

The stack prepares the local Kubernetes cluster so background workers can start one
computer per assistant, including shared group assistants. Hosted tool admission tests use
temporary namespaces in a claimed spare stack; ordinary startup does not yet
install those hosted tool policies.

The [spare-stack rules](#parallel-journeys) describe ownership, port separation,
claim reuse and cleanup after a failed Kubernetes connection. The
[provider setup procedure](#managed-model-calls) describes retries while saved
access is still being applied. The [daily run procedure](#daily-fresh-run) keeps
the timer, saved results and failure-log settings in one place.

The [organisation checks](#organisation-browser-checks) cover participant access,
direct chats, shared assistants and saving provider keys. The
[budget cleanup rules](#budget-journey-cleanup) explain how checks restore limits.
The [demo rehearsal](#timed-demo-rehearsal) explains PDF preparation, warm computers,
recorded spending and restoration after failures or interruptions.

## Earlier development stack guide detail retained during the plain-language update

## infra/dev-stack

## What this is

A set of scripts that starts a full local copy of OpenCrane for development and testing.
It brings the services and apps together on a developer machine. It can also run browser
checks from sign-in through chat, file upload and organisation features.

## Where it fits

This is part of the infrastructure layer. Docker Compose runs its services in containers.
The stack starts OpenCrane apps against them. It uses the
[Kubernetes cluster](../../GLOSSARY.md#kubernetes) prepared by [`infra/devbox`](../devbox/README.md).

```mermaid
flowchart LR
  infra["infra<br/>infrastructure"] --> stack["infra/dev-stack<br/>local OpenCrane"]
  stack -->|starts in Docker| services["Services<br/>PostgreSQL, NATS, OpenFGA, MinIO"]
  stack -->|sets up or checks test sign-in| zitadel["Zitadel<br/>development organisation"]
  stack -->|scans uploaded files| clamav["ClamAV<br/>file scanner"]
  stack -->|starts programs, checks website readiness and PDF answers using attached text or a file read| apps["apps/server, ops, web<br/>OpenCrane programs"]
  stack -->|owns Helm installs and sets the gateway IP| package["package<br/>local Helm install"]
  stack -->|checks spending, uploads, provider access, completed rehearsal replies at both widths, tools and group access loss| apps
  infra --> devbox["infra/devbox<br/>machine setup and k3d cluster"]
  stack -->|checks computer and hosted tool rules in the cluster| devbox
```

## What it is responsible for

When the Spending editor fails to appear, the browser check keeps HTTP status codes
and fixed visibility values for the editor and its loading and access notices.
It records no screenshots, page text or response contents. The check still fails.
The nightly launcher retains the private record before cleanup. The cause of the
intermittent failure is still unknown; this change helps investigate the next failure.

The upload check retries a file list that is still applying. Once the list is
available, it checks the exact file count and waits for workspace delivery.

Separate admission rules check hosted tool images and container settings. Their tests
also check resource changes made through the Pod resize endpoint. Their tests
use temporary namespaces on a claimed spare stack. Startup does not install them yet.

- Start and stop the local services and OpenCrane processes.
  Wait for the website to answer before starting browser checks.
  Secondary memory and survey keys use separate directories owned by that slot.
- Create private local credentials for the services.
- Set up four sign-in test users for each spare stack. Check that the sign-in apps
  include email claims in their signed tokens.
- Check existing test sign-in accounts without changing Zitadel during a fresh
  package run.
- Prepare the local Kubernetes cluster so that the server can start a sandboxed computer for each member.
- Run a local stand-in for the AI model, so checks cost nothing and give the same answer every time.
  Read the converted PDF if the text sent with the question lacks the requested fact.
- Connect and test that provider as the Owner before a fresh stack starts its chat checks.
- Optionally use a real OpenAI provider on a spare stack, with a separate paid chat check.
- Allow an explicit owner real-provider start from an interactive terminal, while refusing fleet tasks.
  Check readiness without sending chat prompts. Restore the saved mode and stop newly
  launched services if the start fails or is interrupted.
- Run browser checks against real local services. The approval journey is currently skipped.
- Declare review details for read-only test tools before the Owner selects Allow.
  Discovery leaves every tool blocked until the exact review is saved.
- Check integration list rows with a hosted display fixture. The fixture makes no
  tool calls and has no remote URL for the catalogue watcher to check.
- Check group chats from the To line, participant access, direct chats, shared assistants and
  provider key saving in a fresh stack.
- Keep one extra computer place so a saved-data repeat can start a new shared assistant.
- Measure reply arrival, process memory and open files during live-view checks.
- Keep up to three separate development stacks on one machine.
- Seed two demo groups and a shared assistant through product APIs, keeping their ids on repeats.
- Prepare a scanned personal PDF, bound company spending, warm computers and time demo checks.
  A smaller approved demo allowance also limits paid calls made during fresh startup.
  Rehearsals save the previous company limits and restore them when they finish or stop.
  Private records identify the run's calls, charges and money still held.
  The separate ten-step rehearsal checks the Models page inside the organisation page.
  It checks the demo provider inside that page.
  Reply checks wait for the new answer to finish, even when it finishes straight away.
  They check its facts and require the same text after a reload.
  Each rehearsal uses separate invitation addresses and chat messages for its width and attempt.
  It saves pictures before reporting a step as passed. Its history pictures show the matching rows.
  It saves failure messages with private values removed, even if a screenshot fails.
  If restoring company limits also fails, it saves both errors and keeps the checker's error first.
- Put the package gateway Service IP in the computer settings before a chat turn starts.
- Run a fresh stub-based check each day in a secondary stack and save its result outside the repository.
  On failure, save the error and recent process logs before removing that stack.

## Processes it handles

A fresh stack with the development Owner connects the local model provider through the
product APIs. It saves a private credential, checks the provider, selects the chat models
and repeats the same request if the server says saved access is still being applied.
It waits for the first default to be recorded. It then explicitly selects that default
and asks to switch on. When accepted, models restarts with that saved
credential before any chat check. A refusal stops startup. Free reachability checks
need no spending settlement. Paid tests and other sends still need confirmed outcomes.
Later starts read the recorded mode again. An explicit real-provider start reads a private
credential file only during setup and saves it through the same product API. Real mode on a spare stack
uses a separate check for streamed answers, Stop, a later member and a supplier PDF.
Changing an existing stack between real and local providers requires a fresh start.
Owner real starts require `--owner-run` and an interactive terminal. Fleet tasks are
refused before owner data is read. Standalone automated journeys also refuse the owner
id and any fleet marker before reading configuration. Stand-in journeys refuse a saved
real-mode stack. Owner starts check health, processes and listening addresses, then
report readiness. The [demo guide](../../docs/process/demo/README.md)
keeps the remaining live checks explicit.

The models process gets a separate control port for checking loaded configuration.
The stack never forwards it. The approval journey is skipped while publication
and call checks are being connected.

1. **A developer starts OpenCrane.** The scripts start the databases and services, then
   start the server, workers and website. Startup waits up to five minutes for the website
   to answer HTTP requests, and stops if its process exits. A spare stack start also runs
   the core browser check after the website is ready.
   Computers update in place after their next pause and keep their home files.
   Admission checks allow only the checked image and settings.
2. **A developer checks a change.** A browser signs in, sends a chat message and checks
   that the reply remains after a reload. Other checks cover uploads, budgets
   and the computer screen. The organisation checks also cover groups, direct chats, shared
   assistants and saving a provider key. Group chat checks cover the mode before the first
   message, who can read each message, quiet ordinary sends, and access clearing after a
   person leaves. Removal timing watches the open page, live connection and API reads
   together, from when the browser sends removal. The Owner list must also update,
   with a longer wait. Audit checks follow older pages when newer grants fill the first page.
   Budget checks use a real group and shared assistant, and restore
   their test limits even if a browser step fails.
3. **A developer runs a separate stack.** `claim.sh` reserves one of two spare test stacks, numbered 1 and 2.
   Its services use separate data and ports, and `down.sh --id` removes that stack and
   releases its id. The demo launcher checks that the returned id matches the requested
   slot before startup or cleanup. A failed request for another id keeps the existing stack.
4. **The daily check runs.** A user timer updates a detached checkout of `main`, then starts
   `up.sh --fresh` in a claimed spare stack. The local model stub keeps it free of paid model
   calls. Each run checks groups, private shared sessions, direct chats and group messages.
   The sender must see each group message within two seconds of its saved reply.
   Saved failure logs have known secrets and credential patterns removed.
   A result line and any failure evidence go in the user's home directory.

## Secondary stack slots

`claim.sh` gives this worktree one of the two spare slots. Its private owner file records
the worktree, the claiming process id and the start time. A later claim reuses the same
slot for this worktree. A claim stays reserved for at least 15 minutes so the stack
has time to start. After that, another worktree can reclaim it if the claiming process
has ended and no stack processes, containers or package namespace are running.
Kubernetes errors keep a package slot busy. `status.sh` reports `free`
for an unused slot and does not create its owner file. `down.sh` also leaves an unused
slot alone.
The spare slot runs either the Compose stack or the local Helm package. Package
preparation refuses a running Compose stack. If Kubernetes is unavailable during
cleanup, `down.sh` stops Compose and keeps any package owner record for a later retry.
Without a package or computer setup record, teardown needs no Kubernetes connection.
A started Compose stack still removes its recorded computer resources.

## How to run or test it

The local machine needs Docker and Node 22. The owner's main stack is reached over Tailscale,
a private network between the owner's own devices, so it needs a signed-in Tailscale session.
The two numbered test stacks are reached only from the machine itself.
The [developer box](../devbox/README.md) sets up the local Kubernetes cluster.

```sh
infra/dev-stack/up.sh
infra/dev-stack/status.sh
infra/dev-stack/down.sh
```

`up.sh --fresh` replaces this stack's local data and credentials. For a spare stack,
it also clears this worktree's website build cache so changed packages are rebuilt.

The daily timer runs at 03:17 UTC. Before each run, its launcher updates the detached
`~/dev/daily-fresh` checkout to the latest `main` and installs packages only when the lock
file changes. It claims a spare stack, starts it fresh with the local model stub, and removes
that stack when the run ends. If both spare stacks are busy, it records that it skipped the
run. Saved logs have known secrets and credential patterns removed. Logs are withheld
if sanitisation fails. Failed group receipts and pictures are kept before cleanup. Results and saved failure
files go in `~/.opencrane/daily-fresh/`, outside the repository.

Run `infra/dev-stack/install-daily-fresh-timer.sh` to install or update the user timer.

## Where to read more

- [README.robot.md](README.robot.md): exact settings, limits, credentials and test details.
- [Demo guide](../../docs/process/demo/README.md): secondary start and owner refresh prerequisites.
- [infra/devbox](../devbox/README.md): the local cluster used for computers.
- [infra/nats](../nats/README.md): the event log's connection rules.
- [infra/clamav](../clamav/README.md): the file scanner used by uploads.
- [Why NATS JetStream holds the event log](../../docs/adr/0001-event-store-nats-jetstream.md).

## Ownership browser check

Manual named organisation journeys include provider saving and the ownership handover,
followed by the existing group chat checks. The separate development owner remains a
separate test user. A short-lived fixture session uses the product commands to appoint
the browser account, then steps down so the browser starts as the sole owner.
No ownership event is added directly by this fixture.

The browser appoints the signed-in member. The former owner steps down to Admin,
and the new owner changes that account to Member through the member detail page.
The check reads member, admin and owner routes to verify the resulting access.
It checks the sole owner's disabled step-down control and sends refused step-down
and self-removal commands. Neither refusal may move the corresponding saved position.
Finally, product commands restore the separate owner, browser Admin and browser Member
so that the same saved data can run again.

The ownership regression first failed because an Admin fixture silently recorded
`NOT PROVEN`. It now refuses that setup. A second test checks preparation and
restoration twice against the same saved accounts. These tests use an API fixture;
the live journey supplies the real browser and server evidence.

The transfer check also matches the command id from the current browser request.
Its failing-first test showed that an earlier appointment of the same person could
otherwise stand in for a missing appointment in a saved-data run.

The first fresh run on `975f73474` stopped after the ownership appointment was
accepted. Its Check status button disappeared between a count and an enabled
check. A failing-first test reproduced that browser race. The read-only status
control is now checked and activated in one browser operation. This adds no wait
or write retry. A browser fixture also checks disabled and removed controls.

The next fresh run on `c3a72c8c5` confirmed the appointment and showed the successor's
owner controls. It stopped after step-down because the script did not use Check status
to read that result into the screen. A failing-first browser test reproduced the missing
read action. Appointment and step-down now use the same status reader. Their existing
120-second and 30-second limits are unchanged. The reader sends no write command.

Names starting with `nightly-` retain the daily job’s groups-only checks. They do not
change providers or owners. A failing-first scope test keeps that distinction.

## Complete waiting approval captures

`captureWaitingApproval(page, output, name)` in `stage-b-capture.ts` replaces the
plain capture calls for `write-waiting` and `write-waiting-reloaded` in the local
live collector. It scrolls the whole card into the chat viewport at 1280 and 390 pixels,
checks both decision buttons and masks email addresses. If a card is taller than
the chat viewport, it increases capture height while keeping the requested width.
It restores the original viewport afterwards and refuses a clipped card.
The retained run-5 script and pictures remain historical evidence.

`browser-audit.ts` checks reserved and settled integer cents through the admin
Change history endpoint, matching the member call by request, permit, conversation,
turn and requester. Member action history must omit both money fields.

Own helper checks: `nice -n 10 node --experimental-strip-types --test
infra/dev-stack/browser-audit.test.ts infra/dev-stack/stage-b-capture.test.ts`.
`npm run visual:stage-b-polish` checks the built website with browser fixtures at both
widths and writes eight captures to `/tmp/stage-b-polish-captures`. These fixtures
check display and collection, not a fresh-install journey.

## Private owner email

The development owner email comes from `<home>/.config/opencrane/dev-owner-email`,
outside the repository and every disposable stack directory. The file contains
only the real email address, on one line. The operator keeps it private with file
mode `0600`. A fresh start or deletion of a claimed stack leaves this file in place,
so the nightly job and new claims can reuse the setting.

The operator supplies the file before an owner bootstrap or packaged install.
The [package notes](../package/README.robot.md#private-owner-email) describe how
the packaged bootstrap receives the same value. No real address belongs in this
repository.

## PostgreSQL installer checks

`packaged.ts` calls `cnpg.ts` after checking package ownership and before Helm runs.
The helper reads operator and credential objects through the claimed Kubernetes
connection. The [package notes](../package/README.robot.md#optional-postgresql-primary-and-standby)
define the accepted version, passwords and unchanged database roles. The helper
requires bootstrap-compatible generated passwords and checks connection values
after the bootstrap Secret overrides runtime settings. The shipped
image review still refuses CNPG; this check does not enable a live installation.

## Recorded package connections

`packaged.ts` carries the context checked at the start into every later
Kubernetes operation. Each operation compares that context with the current target. Helm also compares its explicit context with the checked
target before starting. A missing target cannot redirect an existing target's
package to the shared cluster. Ordinary R1 packages recorded on the shared
cluster retain their existing behaviour.

`packageConnectionArgs` rechecks package ownership and the captured namespace UID
for private preparation and browser forwarding. It supplies the recorded context
and private kubeconfig path without reading or printing credential contents.
The [package notes](../package/README.robot.md#recorded-connection-during-package-operations)
describe the split scope and remaining R3 installation work.
