# Fresh-install repair

Date: 12 October 2026. These checks use secondary slot 1 in
`/home/jente/dev/wt/i365-fresh`, with the local model stub. Each fresh start
replaces the stack's databases, events, computers and generated credentials.
The existing Zitadel test identities remain, as they do in the nightly run.
The stack keeps `jente@elewa.ke` as its seeded owner.

## What failed

The original nightly evidence was read from `~/.opencrane/daily-fresh/ledger.md`
and its dated failure folders. Those files were not changed.

| Nightly run | Finding | Current reproduction |
| --- | --- | --- |
| 8 October | The phone sign-in page was blank. Its log has no browser module diagnostics, so its cause cannot be established separately. | Sign-in passed at both widths on the unmodified-main baseline. |
| 9 October | The browser imported `ownershipChangeSchema` from a saved Vite bundle that did not export it. The daily checkout retains Angular's cache across source updates; the last passing nightly commit did not yet export that schema. | A new worktree passed sign-in. Fresh secondary startup now deletes only its worktree's Angular cache after stopping its website. |
| 11 October | The journey invited the signed-in user under a different email. The join route correctly refused it. The fixture also used an inviter without active owner authority. Main already corrected both in #341. | Joining passed on the unmodified-main baseline. |
| 12 October | The approval fixture had no saved definitions or fresh catalogue dates. Discovery no longer trusts `reviewed: true`, and the old mode event could not authorise an unreviewed tool. The gateway refused the call before asking for approval. | FAIL on current main at the same `Approval needed` assertion. The saved decision was `deny / request_refused`. |
| Current main, after saving the review | The stub route had no running-instance generation or revision-header contract, now required by #350. `mcpDispatch.bindPolicy` refused it with `MCP atomic revision contract unavailable`. | FAIL at the same approval card assertion despite a saved Ask review. |

The same stale fixture pattern occurred later in the integration-list check.
Both fixtures now save complete definitions, matching tool and catalogue digests,
explicit zero costs and five-minute catalogue dates. They read the saved event
revision and submit the exact choices through the signed-in owner's review API.
Discovery is asserted to leave every tool blocked and unreviewed before that save.
The approval tool uses Ask; the list fixture uses Allow for read and Block for write.

An initial repair attempt read the PostgreSQL projection immediately after discovery
and failed because the row was not ready. The final fixture uses the existing event
policy reader for the exact revision. It keeps the authenticated review write on the
real server route. It adds no retry of the write.

The stack now gives its tool stub a new instance id at startup. The installed route
and the stub share that id, and the stub derives its catalogue digest from the same
tool definition as the journey. It compares both headers immediately before recording
an effect. Changed or missing headers return 409. A focused test failed on main's
stub (`200 !== 409`), then passed with the fix. It checks zero recorded effects for
refused calls and unchanged bytes for the matching call.

The projection test also reproduced a later member update stopping on
`computer.view_refused`. That audit event has no assistant id because it does not
change computer ownership. The member index now adds computer ownership links only
for the six lifecycle events, and the test checks both normal updates and a full
rebuild after the refusal.

## What the passing runs must prove

The command is `infra/dev-stack/up.sh --fresh`, with `DEV_STACK_ID=1` and
the existing private Zitadel PAT file. Startup includes the whole nightly journey.
The model is the local stub throughout. No paid model call is made.

The journey checks real sign-in at 390px and 1280px, membership and model grants,
streamed chat, Stop, uploads and refusals, computer viewing and access revocation,
approval cards and reload, exactly one approved upstream tool call, denied and
duplicate calls with no extra effect, computer restart with saved files, the typed
integration list, action history, spending refusals and projection replay.

The nightly script explicitly unsets `P4_JOURNEY_ATTEMPT`; these runs use the same
journey. The separate optional organisation/group-chat extension and screenshot
journey are NOT RUN by this repair. Production approval and access checks, money
rules, existing assertions and their time limits are unchanged.

## Run receipts

Both runs started from a fresh stack in secondary slot 1. They used the local
model stub and the existing private Zitadel PAT file. No paid model call was
made. The stack was stopped after the second run, and slot 1 is free.

| Run | Result | Receipt |
| --- | --- | --- |
| 1 | PASS: 37 journey checks. Sign-in, chat, uploads, live view, approvals at both widths, action history, four spending refusals and both projection replays passed. | [Run 1 receipt](i365-fresh-run-1.txt) |
| 2 | PASS: 37 journey checks with the same coverage. | [Run 2 receipt](i365-fresh-run-2.txt) |

Each run restored approval cards after reload at 390px and 1280px, recorded
exactly one upstream call for the allowed tool, and refused the retry and denial
without another effect. Each passed the `members` and `mcp-catalogue` replay
checks. All four over-ceiling spending calls were refused and stayed refused after
reload. The live view was revoked and its pixels cleared at both widths.

The root suite ran twice. The first run overlapped another worktree's root suite
and had service timeouts. The isolated retry finished with 250 files and 4,176
tests passing, 5 files and 18 tests skipped, and 3 timed-out tests in three
files. The upload timeout came from this branch's required stub generation
missing in its test fixture; that fixture now supplies one. The three affected
files then passed alone: 47 tests passed across upload, gateway approval and
hold recovery. The two other full-suite timeouts did not reproduce in that run.
