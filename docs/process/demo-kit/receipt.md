# Demo group seed and owner guide

20 October 2026. Part of #32. Overall: PARTIAL. This is the first split within the
requested small-change limit. No product event, API, dependency or authority rule changed.

Base: `43cdd68d8b33cba943ca0a770700ae03a332b239`, including the merged real-provider switch.
Test-first commit: `bb3e6b1bb`. Both files failed before implementation because their
entry points did not exist. The recording API checks repeat and lost-response behaviour;
it does not prove a real service accepted a command.

The seed keeps the existing people, creates Acacia Trading and Kijani Logistics,
adds the same two people to both, and creates one Acacia supplier assistant.
Request records survive interrupted runs; an absent original receipt never permits
resubmission. It changes no ceilings and makes no paid call.

PDF fixture/upload, company ceilings, warm-up and the three-minute browser smoke are
left for the next part. No smoke command is advertised as implemented. The owner guide
is gated: main's real-provider switch currently rejects owner mode. A full fresh PASS,
the Stop image and owner-mode support are required before its refresh commands can run.

Owner stack, port 44200, owner data, phone, laptop tunnel and owner refresh: NOT RUN.
No owner command was executed. No live seed or paid call has been made by this task.
The single live stack lane is currently claimed by the Stop/image qualification.

## Own checks

Source: `a873b13fecdc20e9a1b7191f6b56d947c03189ad`. Documentation follows that commit.
All test, lint and typecheck commands use `nice -n 10`. Test commands use
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`; these fixtures do not
need a database. No root suite was run and no database was started.

| Check | Result | Time |
| --- | --- | --- |
| `npm ci` | PASS; existing audit findings retained | 43 seconds |
| Changed Node tests, final two runs | PASS; six each | 3.83 / 3.38 seconds |
| Event security rules | PASS; 438 tests, file unchanged | 3.33 seconds |
| Event catalogue | PASS; 149 event types | Not timed |
| New demo files, strict TypeScript | PASS | Not timed |
| Required workspace/package typecheck | PASS | About 6 minutes |
| Markdown and changelog validation | PASS | Not timed |

Removing the existing-request guard temporarily made the unknown-write test fail:
it observed two POSTs instead of one. Restoring the guard restored PASS. Both
recording fixtures use temporary directories and no live service credentials.
The broad optional dev-stack typecheck remains FAIL on existing daily-fresh,
mcp-journey, wake-latency and Zitadel-test errors. A new request-body typing error
was fixed before the separate demo-file check passed. Required workspace checks
are recorded separately; this does not hide that broader failure.

At 19:31 UTC the full lint command was still running: PARTIAL at this snapshot.
The pull request records its final result and CI on the pushed commit.

## Slot safety and CLI checks

20 October 2026. Source: `ea9f022c6`. These checks use disposable files and recording
fixtures. They do not qualify a live demo.

Fetch and rebase: PASS. `origin/main` was `43cdd68d8b33cba943ca0a770700ae03a332b239`
and was already an ancestor of the branch. Neither rebase state directory remained.

Test commit `25696b16d` came before the slot fix. Its regression failed because a
request for slot 2 called cleanup for the existing slot 1. The corrected launcher
checks the returned id and requested id before installing the cleanup trap. Startup
and seed failures still clean the secondary whose startup this run attempted.
The full explanation of what `--fresh` removes now appears before the owner commands.

CLI test commit `f4c91b3f2` uses the real configuration and session code with synthetic
settings in a temporary home. Its HTTP fixture cannot contact a running stack.
Removing each id, ownership or origin guard made its test fail. Loading configuration
before checking the id also made its test fail. Printing the synthetic provider
credential made the launcher's output assertion fail. All temporary changes were restored.

| Own check | Result |
| --- | --- |
| Changed Node tests, final two runs | PASS; 13 each, 31.05 / 30.50 seconds |
| Focused strict TypeScript check for demo files | PASS |
| Required workspace/package typecheck | PASS |
| Full lint, including knip, docs, links, fixture and licence checks | PASS |
| Event catalogue | PASS; 149 event types |
| `npm run lint:changelog` | PASS |
| Shell syntax and `git diff --check` | PASS |

All test, lint and typecheck commands used `nice -n 10`. The changed-test commands
set `PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`; these tests do not
connect to PostgreSQL. No root suite or live journey ran. No stack was claimed or
started, no model call was made, and the owner stack was untouched. Live qualification
remains NOT RUN. The other test gaps and unfinished demo work remain as described above.

## Interactive owner real mode

21 October 2026. Part of #32. Overall: PARTIAL. This split implements the owner
startup and seed guards. Source: `00fff28ef4d257b1f1bbd9b121a22fb6e8656a25`.
Only this receipt follows that source. The complete PDF, ceilings, warm-up and timed rehearsal
need a separate change to stay within the requested small-change limit.

Base: `523fc7218`, which includes the real-provider switch, demo seed and refreshed
computer image. Startup test commit `337b51728` failed before the implementation:
owner mode was refused and the new flag was not accepted. Test commit `ad457a8e3`
recorded two more failures: owner seed loaded configuration from a non-interactive
process, and the fleet launcher did not supply its marker. Test commit `dadb7ce33`
then showed that an unmarked headless stand-in start could still reach setup.
The fix refuses that case before reading or creating owner data.

The explicit startup flag now requires TTY stdin and refuses any fleet marker,
including an empty one. The seed applies the same checks before loading owner
configuration. Fleet children inherit a marker. Real owner startup does not start
or require the stand-in model. Provider setup still takes a file path and uses the
existing product API. No event, API, dependency, access check or money rule changed.

Recording fixtures use temporary homes, synthetic credentials, replacement system
commands and a replacement HTTP boundary. Terminal cases use a disposable pseudo-terminal.
They cannot reach owner services. Accepted startup stops at the fake Tailscale command;
it does not prove that a real owner install starts. Tests cover shell flag forwarding,
fresh and saved real mode, non-interactive refusal, fleet refusal with a terminal,
seed refusal before configuration and successful seed requests to the recording API.

No live owner command ran. The owner stack, port 44200 and owner data were untouched.
No secondary slot was claimed, started or released. Temporary fixture files were removed.
Paid calls by this task: **0; charged 0 cents; held 0 cents**. No daily allowance was used.
The owner refresh still needs a qualified merged SHA. The guide no longer describes
owner real mode or the refreshed image as missing; it keeps the remaining live gates.

| Live smoke step | First run | Second run |
| --- | --- | --- |
| Warm-up | NOT RUN | NOT RUN |
| Streaming and reload | NOT RUN | NOT RUN |
| Scanned PDF facts, preview and download | NOT RUN | NOT RUN |
| Stop persistence with the real provider | NOT RUN | NOT RUN |
| Direct delivery | NOT RUN | NOT RUN |
| Shared-assistant reply | NOT RUN | NOT RUN |
| Company-limit refusal and restore | NOT RUN | NOT RUN |
| Complete warm smoke within three minutes | NOT RUN | NOT RUN |
| Screenshots at 1280 and 390 pixels | NOT RUN | NOT RUN |

Owner refresh, owner real replies, laptop tunnel and real phone access: NOT RUN.
The earlier stand-in Stop evidence does not qualify Stop with a real model.

All commands below used `nice -n 10`. Node fixtures and event security tests used
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`; they do not connect
to PostgreSQL. No database container or full root suite was needed for this slice.
`npm ci` ran in this worktree, and its NATS and Lychee tools are symlinks to the
requested checkout. Local check logs are in `/tmp/demo-kit-2-checks/` on the builder host.

| Own check | Result | Duration |
| --- | --- | --- |
| `npm ci` | PASS | 26 seconds |
| Changed and related recording tests, two final runs | PASS; 31 each | 95.61 / 83.29 seconds |
| Event security rules, unchanged | PASS; 438 tests | 4.88 seconds |
| Workspace and package typecheck | PASS | 308.58 seconds |
| Focused TypeScript for seed, guard and changed tests | PASS | 20.88 seconds |
| Event catalogue | PASS; 149 types | Not timed |
| Knip | PASS | Not timed |
| Markdown and changelog checks | PASS | Not timed |
| Shell syntax, diff whitespace and secret scan | PASS | Not timed |
| Relocated fleet fixture, two runs | PASS; one each | 0.42 / 0.47 seconds |
| Initial full lint | FAIL: test outside a TypeScript project | 614.30 seconds |
| Full lint after moving the fixture | PARTIAL; running at this snapshot | — |
| Pushed-commit GitHub `ci-ok` | NOT RUN at this snapshot | — |

The fleet test now lives beside the existing dev-stack command fixtures, and CI
runs it there. The focused TypeScript check passed again after the move. No lint
rule or project exclusion was changed. The draft PR records the final full-lint
result and CI result on its pushed commit.

## Owner startup readiness and recovery

21 October 2026. Source: `232ae3f7afd57027d0471027abd0d96d15f6f2cd`.
Rebased onto `dc44c6cfc12045494d57504e275c00810476c3ed`; the rebase finished cleanly.
A range comparison confirmed that the branch commits kept their changes.
Overall: PARTIAL. Live owner qualification remains NOT RUN.

The accepted owner startup fixture now reaches the readiness report. It replaces
process launches, configuration, service adapters and network calls. Owner starts
check health, running processes and listener addresses without running a chat journey.
Real mode is saved after infrastructure and provider checks. Failed starts restore
absent, stand-in and real saved modes and stop their launched services. Both SIGINT
and SIGTERM after switch-on restore the previous stand-in mode and stop those services.
A fresh reset still erases data; restoring the mode does not undo that reset.

Automated entry tests cover the shell, direct stack journey, main journey, bootstrap,
MCP, screenshot, repeated live-view and package chat scripts. Owner and fleet calls
stop before configuration. The main journey checks saved mode before setup; stand-in
chat drivers refuse saved real mode. The demo guide now documents stopping the stack,
removing the provider file setting and making a fresh stand-in start, with the data-wipe
warning before the commands. Other unfinished demo work and listed test gaps remain.

Failing tests preceded implementation in commits `5bcd18640`, `dbb5cb3f6`, `8f761672e`,
`2e6ad7640` and `3f49d940c`. Three removal probes each caused an assertion failure:
non-start owner consent, duplicate startup options and secondary owner consent.
All probes were restored. These are checks by the builder.

| Own check on the rebased source | Result |
| --- | --- |
| Changed and related Node fixtures, 11 files, twice | PASS; 89 tests each, 196.59 / 183.18 seconds |
| Workspace and package typecheck | PASS |
| Focused TypeScript for new guards and tests | PASS |
| Full lint | PASS; no errors, 22 warnings in unchanged code |
| Event catalogue | PASS; 149 event types |
| Knip | PASS |
| Changelog check | PASS |
| Shell syntax and diff whitespace | PASS |
| Three guard-removal probes | PASS; each removal was detected |

Test, lint and typecheck commands used `nice -n 10`. Tests set
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`; these fixtures do not
connect to PostgreSQL. No full root suite ran. The old-base lint run and second test
run were stopped when main advanced; the checks restarted after the rebase.
Logs are in `/tmp/demo-kit-2-fixes/` on this host.

No live owner command ran. The owner stack, port 44200 and owner data were untouched.
No secondary stack was claimed or started, and no paid model call ran. All temporary
fixture files were removed. No access, money, memory or key-handling rule changed.
The provider key still enters setup by file path only. Fresh-install qualification,
real owner replies, laptop tunnelling and real-phone access remain NOT RUN.

## 21 October 2026 — PDF preparation and timed smoke

Source: `de6b2a800a7a62c3eb9432bc819b88dfc54c541a`, on main
`523fc7218f4c84addbb8ddccf7fbccd48952e593`. Overall: PARTIAL.
Test commits `570f96029` and `33fce5529` failed on their missing entry points
before implementation. Recording fixtures prove that lost replies and unknown
receipts never cause another write. They also check integer company ceilings,
the personal PDF upload, unsafe slot refusals and timed result recording.
Test commit `9ee1fa8e3` adds a browser fixture for repeated limit checks.
Restoring the old selector made it fail with `Missing expected rejection`.
The corrected check follows the current message and cannot accept an older refusal.

The checked single-page quote says EUR 1,234.56 and delivery 17 November 2026.
Preparation uses the existing group seed, authenticated APIs, request records and
server receipts. It changes only company ceilings. No dependency, event, API or
access rule changes. The owner-mode work in PR #546 is neither copied nor required.

| Own check | Result | Time |
| --- | --- | --- |
| `npm ci`; tool symlinks | PASS | 32 s |
| Demo and budget-helper tests, final two runs | PASS; 21 each | 33.96 / 30.34 s |
| Event security rules, unchanged | PASS; 438 tests | 3.03 s |
| Event catalogue | PASS; 149 types | 0.96 s |
| Focused strict TypeScript check | PASS | Not timed |
| Workspace/package typecheck | PASS | Not timed |
| Standalone Chromium PDF rendering and visual inspection | PASS; one readable page | Not timed |
| Full lint including knip | PASS on repeat; first run ended with SIGTERM (143) | 733 s |
| Changelog and Markdown checks | PASS after removing a blank line | Not timed |

Tests use `PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres` and
`nice -n 10`; these recording fixtures do not connect to PostgreSQL. No root suite
or database container was started. Full lint and typecheck also use `nice -n 10`.

| Real warm-slot smoke | First attempt | Second attempt |
| --- | --- | --- |
| Streaming and reload | NOT RUN | NOT RUN |
| PDF facts, rendered preview and original download | NOT RUN | NOT RUN |
| Stop and partial reply after reload | NOT RUN | NOT RUN |
| Live direct delivery | NOT RUN | NOT RUN |
| Shared-assistant reply | NOT RUN | NOT RUN |
| Company-limit refusal and restore | NOT RUN | NOT RUN |
| Three-minute duration and 1280/390 screenshots | NOT RUN | NOT RUN |

Real preparation, warm-up and smoke timings: NOT RUN. Paid calls: zero;
charged: 0 cents; held: 0 cents. The remaining shared daily allowance is not
recorded in the available receipts. Its current value has been requested before
paid execution. No secondary was claimed or created, so no cleanup is due.
Real-model Stop diagnosis and fresh-install qualification remain NOT RUN.
The owner stack, owner refresh, laptop tunnel and real phone remain untouched
and NOT RUN. Browser viewport checks would not qualify a physical phone.

A later confirmation exposed a 100 ms fixture-load timeout. Only the assertion
that a refusal is absent now uses that short deadline; page setup uses the normal
fixture timeout. Both corrected runs passed. No application timeout changed.
The pull request records GitHub `ci-ok` on the pushed commit.

## 21 October 2026 — paid secondary rehearsal

Overall: PARTIAL. The two three-minute runs failed. This section replaces the
previous NOT RUN status for paid execution. It does not qualify the demo as done.

At the start, fetch and rebase onto `dc44c6cfc12045494d57504e275c00810476c3ed`
completed. The base was an ancestor and neither rebase state directory remained.
One secondary, slot 1, was claimed through `claim.sh`. The owner stack and port
44200 were untouched. Real startup began at 05:20:38 UTC. Its initial live checks
passed arithmetic with reload, a later member reply and PDF facts. Stop failed.
The provider was supplied only by its key-file path to private setup and the
existing custody API. No credential value is included in this evidence.

The company daily and monthly ceilings were both 600 cents before the first paid
verification. The event record confirms this at 05:21:25 UTC. The refreshed computer
image was `sha256:a30319e3744510ea38fa59928f0881444a51c61c33934e0458f87189413515bc`.
The orchestrator authorised a maximum of 600 cents from the remaining shared daily
allowance of 2,000 cents. No ceiling above 600 cents was set.

### Findings and small fixes

Each behaviour fix has a separate preceding failing test commit.

| Finding | Failing test | Fix |
| --- | --- | --- |
| Real startup seeded a larger cap before paid verification | `d0d3e076f` | `1f55c3e4d`: apply the integer allowance during startup |
| The new personal chat's receipt endpoint refused access before the chat existed | `f3873dd72` | `2f562698a`: create once, then read its receipt; never repeat an uncertain write |
| A full bridge queue discarded reports it had already accepted after disconnect | `dc9ff27a4` | `4e410887e`: save the bounded accepted queue after disconnect |
| Shared warm-up waited in the pending session chooser | `4d72f391a` | `79af6c5c7`: use the existing session status helper |
| Stop waited for the composer while the reply already offered Stop | `e5c2a88ef` | `819d00fdb`: use the reply's Stop control |

The first Stop request was saved at 05:25:04.481. The computer finished its report
journal at 05:25:16.275, but the server had saved only 102 of 594 reports at
05:29:50 and 184 by 05:37:00. Replay filled the 64-report queue and closed the
connection with code 1013, `Report queue limit`. The old connection check then
skipped accepted reports. The regression saved only one of 64 accepted reports
before the fix and all 64 after it. The byte and count limits remain unchanged.

After restarting only this slot's server on the fix, all 594 reports were saved
by 05:41:38.322. The waiting PDF arrived at 05:42:08.689. The computer journal's
line 594 was `agent.turn_failed`; gateway usage line 2 recorded `missing_usage`
for reservation `2e84f204-b6e9-4941-8d00-d450bb06dffb`. Its 16 cents remain held.
[Stop evidence](stop-diagnosis.json) records the report lines, event positions and
times without message text. No access, money or memory check was weakened.

### Timed runs

Source: `41ba473efd3f6dd291197535c2ab2fead16e30d9`. Warm-up took 45.723 seconds.
The server included the bridge fix. These runs preceded the Stop-selector fix.
Screenshots added a small amount of time to successful steps. The three-minute
deadline closed both pages and prevented later steps from running.

| Smoke step | 1280 pixels, 05:52:38 UTC | 390 pixels, 05:55:39 UTC |
| --- | --- | --- |
| Streaming and reload | PASS, 18.676 s | FAIL, 180.053 s |
| PDF facts, rendered preview and identical original download | PASS, 22.089 s | NOT RUN |
| Stop and partial reply after reload | FAIL, 139.379 s | NOT RUN |
| Live direct delivery | NOT RUN | NOT RUN |
| Shared-assistant reply | NOT RUN | NOT RUN |
| Company-limit refusal and restore | NOT RUN | NOT RUN |
| Whole run within three minutes | FAIL, 180.144 s | FAIL, 180.054 s |

The first timed Stop submitted turn `8a51c5ed-e1a6-41b0-b252-7bcd1a177e4b`
at 05:53:23.577. It saved no Stop request: the helper waited for the absent
composer control while the reply offered Stop. Its computer journal grew to
2,664 reports. Gateway usage line 10 recorded `missing_usage`, leaving 18 cents
held. The next attempt could not use the supplier chat. The bridge fix alone did
not make this long reply recover within the smoke deadline. The remaining delay
needs further work; this rehearsal does not claim a complete Stop fix.

[Raw timed results](paid-timings.json) preserve every result, including NOT RUN.
[Startup results](paid-startup.json) record the earlier fresh-install checks.

### Separate follow-up steps

These used the same action functions and assertions, one action at a time, with
its own three-minute deadline. They are not a passing end-to-end smoke.

| Step | 1280 pixels | 390 pixels |
| --- | --- | --- |
| Direct delivery | PARTIAL, 13.269 s | FAIL, 180.073 s |
| Shared-assistant reply and reload | PASS, 40.526 s | PASS, 31.790 s |
| Company-limit refusal, reload and restore | PASS, 39.785 s | PASS, 36.633 s |

Direct-delivery assertions passed on desktop, but the screenshot immediately
showed “You no longer have access”. That contradicts a complete PASS. The second
attempt timed out. No access check was bypassed or relaxed. This remains a blocker.
Both company-limit checks refused the current prompt, preserved charged and held
amounts, and restored both company ceilings to 600 cents. Neither made a paid call.
[Follow-up timings](paid-extra-timings.json) retain the raw assertion results;
the desktop direct result above also includes the screenshot finding.

The owner stack, owner refresh, laptop tunnel and physical phone remain NOT RUN.
A 390-pixel Chromium viewport does not qualify a real phone. A fresh install with
all final fixes and a complete repeated smoke remains NOT RUN.

The final Stop helper was also tried in fresh chats at both widths on source
`eb9e5a46e`. Both failed waiting for streaming: 136.908 and 137.272 seconds.
The first request started its paid call later, after its browser timeout. The
second screenshot reports an uncertain message receipt. No uncertain command
was resubmitted. [Fresh-chat results](paid-fresh-timings.json) preserve both attempts.
At 06:09:08 the supplier messages read returned 200; at 06:09:13 it returned 503,
as did approvals. [HTTP observations](paid-access-responses.json) contain only
paths, times and status codes. The saved session cookie had not expired.

### Paid calls and screenshots

Final recorded spending: **25 cents charged, 50 cents held; 75 cents total**.
Three calls have unknown usage, so their full holds remain in the total.
No call was made after the 600-cent allowance was reached; it was never reached.
After the limit checks restored 600 cents, the daily ceiling was lowered to the
25 cents already charged to prevent queued work dispatching during shutdown.
The budget snapshot confirms that change. Removing a disposable stack does not
make its outstanding provider usage known or release this task's reported holds.

| Paid call | Initial reservation, cents | Charged, cents | Still held, cents |
| --- | --- | --- | --- |
| Provider verification | 1 | 1 | 0 |
| Startup arithmetic | 16 | 3 | 0 |
| Startup Stop | 16 | Unknown | 16 |
| Startup later-member reply | 16 | 3 | 0 |
| Startup PDF facts | 16 | 3 | 0 |
| First personal warm-up | 16 | 3 | 0 |
| Repeated personal warm-up | 17 | 1 | 0 |
| Shared warm-up | 15 | 3 | 0 |
| Timed streaming, 1280 | 17 | 1 | 0 |
| Timed PDF, 1280 | 17 | 1 | 0 |
| Timed Stop, 1280 | 18 | Unknown | 18 |
| Separate shared reply, 1280 | 15 | 3 | 0 |
| Separate shared reply, 390 | 15 | 3 | 0 |
| Fresh Stop, 1280, dispatched late | 16 | Unknown | 16 |

[Call ledger](paid-calls.json), [budget events](paid-budget-events.json) and
[gateway usage](paid-gateway-usage.json) retain identifiers and times for each call.
There was no additional paid call in the second timed attempt, direct delivery,
either refusal check, or the second fresh Stop attempt before shutdown.

The screenshots were visually checked for secrets and private locations:
[desktop reply](paid-streaming-1280.png), [desktop PDF](paid-pdf-1280.png),
[desktop direct failure](paid-direct-step-1280.png),
[desktop shared reply](paid-shared-step-1280.png),
[narrow shared reply](paid-shared-step-390.png),
[desktop refusal](paid-limit-step-1280.png),
[narrow refusal](paid-limit-step-390.png),
[narrow reconnect state](paid-access-390.png),
[desktop fresh Stop failure](paid-fresh-stop-1280.png) and
[narrow uncertain message](paid-fresh-stop-390.png).
The separate narrow PDF preview attempt timed out waiting for its Open button;
there is no passing narrow PDF screenshot. Failure images are evidence of the
remaining problems, not proof of a successful journey.

### Cleanup and final source checks

Slot cleanup: PASS. `down.sh --id 1` completed and removed the slot's directory,
including its claim, services, volumes and computer namespaces. This is the
release operation for slots obtained through `claim.sh`; that script has no
separate release option. Only this worktree's secondary was removed.

After the live run, main advanced. Fetch and rebase onto
`a7b564bf41a8de9ddc5a21d43a1142d7958caf65` also completed. Both rebase state
directories were absent and main was an ancestor. The fix table uses the rebased
commit ids. The live JSON files retain the SHAs actually used during the runs.
The final source fixes end at `819d00fdb`; the live evidence commit is `e11b31b23`.
No further paid run was made after this rebase.

| Own final check | Result | Time |
| --- | --- | --- |
| Focused Node tests, serial runs | PASS, 31 tests each | 241.185 / 141.228 s |
| Bridge pressure regression and existing pressure tests | PASS, 3 tests | 23.14 s |
| Bridge pressure and replay tests after the final rebase | PASS, 49 tests | 180.65 s |
| Event security rules, unchanged | PASS, 438 tests | 6.14 s |
| Event catalogue | PASS, 149 event types | Not timed |
| Changelog validation | PASS | Not timed |

The earlier broad bridge run failed three time-sensitive replay read-count
assertions while the stack was busy. The final 49-test run passed unchanged after
slot cleanup. An earlier parallel Node run also hit two CLI fixture timeouts;
both final serial runs passed without loosening assertions. The new bridge
regression passed in both final bridge runs.

Tests, lint and typecheck used `nice -n 10`. The Node fixtures used
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`; they do not connect
to that database. Bridge tests used a task-owned PostgreSQL 17.6 container on a
random localhost port, checked with `pg_isready`, and its actual `PG_TEST_URL`.
The test database was removed with `docker rm -f -v pgtest-demo-kit-3` after the
checks. No full root suite ran. Temporary browser sessions and observation
helpers were removed. The pre-existing tool symlinks were kept.

Required workspace/package typecheck: PASS. The separate strict demo-script
check first found an optional assistant id that TypeScript could not narrow.
Commit `4971d53d9` splits the existing validation into presence and personal-id
checks. It accepts the same ids and changes no request or retry behaviour.
The focused strict check then passed. Preparation tests passed twice more:
three tests each, 3.131 / 3.131 seconds. This is the final source-code commit.

Full lint: PASS, including dependency rules, knip, Markdown, links, fixture checks,
reviewed component licences and changelog validation. ESLint reported zero errors
and 23 warnings. An earlier lint process was paused during live work and replaced
with this complete run after cleanup. `git diff --check`: PASS.

The source checks are green; live qualification remains PARTIAL as recorded
above. GitHub CI on the final pushed commit is reported on the pull request.
