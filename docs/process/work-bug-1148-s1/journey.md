# Long-chat approval and Stop journey

Date: 23 November 2026 UTC. Builder's own qualification only.

Journey on a fresh dev stack: FAIL

## Main comparison (23 November, fix round 4)

Main publication: FAIL. Full slice journey: FAIL. No product code changed.

Fetched `origin/main` and created a clean detached worktree at
`5576ecd1ddb82149eff8132d613293d1acfb05ab`, which contains #1174.
`nice -n 10 npm ci` passed there before any stack command. Main stayed at that
commit on the final fetch; it is already an ancestor of this branch, so no new
rebase was required and no rebase is in progress.

Ten admission samples from 05:47:35 to 05:52:47 UTC showed both secondary
slots free, no running `package-*` stack and one-minute load below six. The
qualifying interval lasted 312 seconds. Claimed slot 1 from the detached worktree
and passed `--id 1` literally to fresh startup, status and teardown commands.

Fresh startup's automatic CORE journey failed at the mobile upload step:
`Creation catch-up timed out` in `waitForUpload`. Startup and service logs were
saved immediately. Services kept running and HTTP health checks passed, so the
separate publication check continued on this same fresh stack. No second startup or publication retry ran.
Load rose after admission; this observation does not establish a cause.

The unchanged guarded launcher reported both server and models ready. An external
comparison driver reused main's sign-in and owner setup, then the branch's current
`prepareApprovalTool` and `reviewSavedJourneyTools` helpers against main's services.
The driver lived outside tracked source. Main's tracked application, library and
infrastructure files remained unchanged. Its older default journey publication
helper was not used for this check because it sends the legacy publication payload.

The saved events show:

| Position | Event | UTC |
| --- | --- | --- |
| 241 | `mcp.server_registered` | 06:03:01.133 |
| 242 | `mcp.server_discovered` | 06:03:02.181 |
| 243 | `mcp.server_reviewed` | 06:03:02.633 |
| 244 | `mcp.server_published` | 06:03:02.918 |

Publication carried all six current intent fields, including the command id,
expected sequence, review revision and fragment digest. The unchanged 90-second
publication wait failed with `Approval journey setup timeout`.
No `gateway.configuration_requested` or gateway observation was saved.

Main failed earlier than the branch's previous observation. Its dispatcher logged
`JetStreamError: heartbeats missed`, followed by
`Worker failed; inspect service health before restarting`, at 05:59:01.485 UTC.
The later database snapshot found dispatcher position 227, event-log position 247
and no `prepare-gateway-configuration` job. This main run therefore did not reach
that reaction. It does not reproduce the branch's completed-handler case or prove
that enqueueing inside the held transaction caused either failure.

The publication handler, policy folding, configuration preparation, dispatcher and
queue sources are identical on main and this branch. The decision-index reader is
used for conversation decisions; the preparation handler reads the MCP server stream
through the unchanged history helper. No direct decision-index change to that
reaction was found. The live main failure prevents attributing the missing request
to this branch alone.

Stopped code work as instructed: main also cannot complete the publication path.
The orchestrator must open the main bug. Finding 4 remains blocking in this PR.
Approval with a returned tool result, single use, reload and the post-Stop 403 with
no upstream effect are NOT RUN. The 500-message seed was not repeated for this
publication-only main comparison. Paid calls: zero.

The private receipt `bug-1148-main-round4` retains admission samples, dependency
installation output, the external comparison driver, event and dispatcher snapshots,
sanitised startup/service/container/pod logs and available CORE captures. Logs were
copied before teardown. The launcher was stopped, `down.sh --id 1` succeeded and
slot 1 reported `free`.

## Journey 6 (23 November)

The earlier controlled receipt has no guarded-launcher readiness log or demo recorder
file. Its worker log shows the registered demo server was rejected during discovery;
there is no discovered catalogue, review or publication. The launcher was not proven
ready or reachable in that run. The catalogue timeout happened before approval.

The first fresh reproduction passed CORE at 390 px and 1280 px. A setup retry then
hit `EADDRINUSE` for the demo Unix socket, before discovery. The stack was stopped and
its logs and screenshots were copied before teardown. No approval step or upstream
effect ran.

On the next fresh slot 1 stack, the demo socket was absent and had no listener. The
guarded TLS launcher reported both server and models ready before the focused journey
started. The 500 earlier messages and their completion events passed setup. Discovery,
review and publication were recorded for the demo server, and the dispatcher ran
`prepare-gateway-configuration` for the publication. The saved worker logs contain no
matching `gateway.configuration_requested` after that publication. The publication
readiness check stayed non-ready for 90 seconds and `prepareApprovalTool` timed out at
its publication wait. Discovery and review therefore ran; gateway acknowledgement did
not complete.

The focused run stopped before any approval request or tool execution. The demo
recorder contained zero upstream effects. Single use, reload restoration and the
post-Stop 403 using the same approved bytes are NOT RUN. Paid calls: zero. Sanitised
service logs and screenshots were copied before teardown; slot 1 reported free after
`down.sh --id 1`. No product code changed. The missing gateway preparation/acknowledgement
is a product-path blocker; its cause is not established in this run.

## Owner option A controlled journey (23 November)

The branch tip was `c576a3b73`. The required five-minute load samples stayed below six.
At approximately 02:39:44 UTC, however, the slot 1 status output listed stopped services
instead of reporting `free`. Later samples at 02:40:14 and 02:40:50 reported both slots
free, and slot 1 was claimed at 02:41:09. Continuous free status for the full five minutes
cannot be established, so the admission check is PARTIAL.

Fresh startup on secondary slot 1 completed. CORE passed at 390 px and 1280 px, including
streamed stub replies, reload, Stop, uploads, live view, and the remaining standard checks.
Paid calls: zero. The automatic CORE journey skipped the focused approval check by design.

The focused journey seeded 500 earlier messages and 500 matching completion events. It
waited for the conversations projection after each of its 50 batches before continuing.
It then failed during tool setup: `waitForApprovalSetup` in
`infra/dev-stack/approval-tool.ts` asserted `Approval journey setup timeout` after its
90-second wait for the registered tool catalogue. This occurred from
`prepareApprovalTool`, before any approval request or upstream tool result.

Approval use, the single-use replay, reload restoration, and the post-Stop request using
the same approved bytes were NOT RUN. The 403 and no-further-effect condition remains
unproved. Sanitised startup and service logs and the 390 px and 1280 px screenshots were
copied to the private receipt before `down.sh --id 1`; teardown succeeded and slot 1
reported free. No product code changed. No retry was made.

## Controlled comparison attempt

The admission window passed from 01:33:20 to 01:38:37 UTC on 23 November:
both secondary slots stayed free, no `package-*` stack was up, and every sampled
one-minute load stayed below six. The detached `origin/main` worktree was at
`5576ecd1d`.

The main-branch run stopped before a slot was claimed or a stack was started.
`claim.sh` failed twice with `Error [ERR_MODULE_NOT_FOUND]: Cannot find package
'minio' imported from infra/dev-stack/stack.ts`, then reported:
`Both secondary stack ids are claimed or have occupied ports; release a slot before retrying.`
Both status checks then reported `free`. No startup or service logs, screenshots,
or paid calls were produced. The failed step ended this controlled run: main CORE,
branch CORE and the focused 500-message approval and Stop proof are NOT RUN.
No product code changed.

## Controlled attempt after the rebase

CI passed on source `98c87b066`. The five-minute preflight passed on secondary
slots 1 and 2: 13 samples over 6 minutes 9 seconds showed both slots free, no
package stack and one-minute load between 0.68 and 1.41.

Startup of the `origin/main` source `5576ecd1d` was refused before provisioning:
`Stack id must be owner, 1 or 2` (exit 2). `DEV_STACK_ID` had been set in the
claim shell, but was absent from the separate startup shell. No services or
screenshots were produced. CORE on `origin/main`, CORE on this branch, and the
focused 500-message approval and Stop journey are NOT RUN. Paid calls: zero.
The startup and status evidence was saved before `down.sh --id 1`; slot 1 then
reported free. No product code changed.

## Earlier follow-up attempt

The follow-up run tested source `85e52f13c` on fresh secondary slot 1. CORE failed
at 390 px during the basic chat before live computer viewing. The 1280 px CORE and
focused long-chat journey were NOT RUN. The previous round-four live-view failure
and this earlier chat failure are separate results. No code was changed. The PR
stays draft. No independent review result is claimed.

## Follow-up fresh attempt

The [availability samples](availability-journey1.csv) record the full qualifying
five-minute interval from 08:48:29 to 08:53:47 UTC. Both slots were free, no package
stack or test suite was running, and every one-minute load sample was below six.
Slot 1 was claimed at 08:56 UTC and started with `up.sh --fresh --id 1`.

CORE failed at 390 px while `browserChatJourney` waited 30 seconds for `.caret` at
`infra/dev-stack/browser-chat.ts:33:32`. The [failure capture](core-attempt5-failure-390.png)
shows the incomplete basic chat reply. Browser transport failures were none. The
failure is different from round four's wait for the fourth live-view reply to show
Done; that step was not reached, so the origin/main comparison was not run.

Host load was already high during startup: one-minute samples reached 10.08 at
08:58:50, 19.63 at 09:00:50 and 16.24 at 09:01:20 UTC near the failure. The private
receipt `bug-1148-s1-journey1` retains the complete load trace, sanitised startup,
service, container and pod logs, and the failure screenshot. The provider check used
`provider-dev-stub`; paid calls were zero. The stack was stopped and slot 1 reported
free at 09:03 UTC.

| Condition | 390 px | 1280 px |
| --- | --- | --- |
| CORE chat, reload, Stop and uploads | FAIL: `.caret` did not appear | NOT RUN |
| Agent reply completes while viewing the computer | NOT RUN | NOT RUN |
| CORE live-view revocation | NOT RUN | NOT RUN |
| Complete 500 earlier messages and their completion events | NOT RUN | NOT RUN |
| Native tool approval and returned result in the long chat | NOT RUN | NOT RUN |
| Exact forwarded bytes, one use, denial and reload | NOT RUN | NOT RUN |
| Same approved bytes return 403 after Stop, without another effect | NOT RUN | NOT RUN |

No retry was made. The previous round-four failure remains the only observed failure
of the fourth live-view reply; this attempt did not reach that step. The focused
journey, approval, exact-byte checks and post-Stop denial remain unproved.

The owner's 20 November option A changes the live seed to 500 earlier messages,
each with its completion event. The unchanged source regression still requires
3,000 messages and their 3,000 completions. The live count remains far above the
unchanged 64-position read cap. Every assertion, deadline and resource limit is unchanged.

## Round-four fresh attempt

Receipt `live-20261120T080649Z` followed a 300-second qualifying interval. Both slots
were free, no package stack was running and load stayed below six. The
[availability samples](availability-round4.csv) retain the earlier resets and the
completed interval. Startup began at 08:07 UTC with `claim.sh` and `up.sh --fresh`.

The 390 px [chat capture](round4-chat-390.png) shows the completed reply and the
stopped partial reply restored after reload. Chat and upload assertions completed.
The [failure capture](round4-core-failure-390.png) shows the computer still Viewing.
The saved error is:

```text
locator.waitFor: Timeout 30000ms exceeded.
Call log:
  - waiting for getByRole('article', { name: 'Agent reply', exact: true }).nth(3).getByText('Done', { exact: true }) to be visible
```

The caller is `browserLiveViewJourney` at `infra/dev-stack/browser-live-view.ts:158:64`.
The run also reported `net::ERR_FAILED` and three `net::ERR_ABORTED` browser transport
failures. The cause is not established. Host load rose after admission; that observation
does not establish why this wait failed. No retry, longer timeout or new fix was attempted.

| Condition | 390 px | 1280 px |
| --- | --- | --- |
| CORE chat, reload, Stop and uploads | PASS | NOT RUN |
| Agent reply completes while viewing the computer | FAIL | NOT RUN |
| CORE live-view revocation | NOT RUN | NOT RUN |
| Complete 500 earlier messages and their completion events | NOT RUN | NOT RUN |
| Native tool approval and returned result in the long chat | NOT RUN | NOT RUN |
| Exact forwarded bytes, one use, denial and reload | NOT RUN | NOT RUN |
| Same approved bytes return 403 after Stop, without another effect | NOT RUN | NOT RUN |

Startup, service, container and pod logs and current screenshots were copied to the
private fleet receipt before teardown. Slot 1 then reported free at 08:15 UTC.
The guarded TLS launcher and focused seed were never started. Paid calls: zero.
The [round-four receipt](rework4.md) records source checks. Earlier failures below
remain failures.

## Previous fresh attempts

Every startup used `claim.sh` and `up.sh --fresh` on secondary slot 1, after both
slots were free, no package stack was running and load had remained below six
for five minutes. The [availability samples](availability-round3.csv) retain the
observations, including earlier preflight refusals before any startup.

| Receipt identifier | Source | CORE | Focused journey |
| --- | --- | --- | --- |
| `live-20261119T234555Z` | `c14be2419` | PASS, both widths | FAIL: first batch expected 556, observed 516 at thirty seconds; later reached 556 |
| `live-20261120T001755Z` | `8e5056f7a` | FAIL: uploaded-text reply at 1280 px never reached Done within 120 seconds | NOT RUN |
| `live-20261120T003423Z` | `8e5056f7a` | PASS, both widths | FAIL: launcher stopped during seed setup after about twenty minutes |
| `live-20261120T014756Z` | `2b0528bf9` | PASS, both widths | FAIL: launcher stopped during seed setup after about twenty minutes |

The qualifying low-load intervals lasted 302, 304, 305 and 305 seconds respectively.
After the mandatory rebase, a short new eligibility wait qualified the current-head
[attempt](availability-rebased-round3.csv). It started before its 01:49 UTC cutoff.
Execution was capped at 02:30 UTC to preserve teardown and the four-hour task boundary.

[Final mobile CORE capture](core-390.png) and
[final desktop CORE capture](core-1280.png) show the successful CORE chat and Stop.
The [earlier desktop failure](core-upload-failure-1280.png) remains recorded separately.
The earlier attempt in [round two](rework2.md) also remains a failure.

## Round-three focused result

History setup was shared and failed before either focused viewport sequence began.

| Condition | 390 px | 1280 px |
| --- | --- | --- |
| CORE chat, reload, Stop, uploads and live-view revocation | PASS | PASS |
| Guarded TLS launcher ready | PASS, shared setup | PASS, shared setup |
| Complete 3,000 earlier messages and their completions | FAIL, shared setup | FAIL, shared setup |
| Long chat answers with native tool approval and returned result | NOT RUN | NOT RUN |
| Exact forwarded bytes, one use, denial and reload | NOT RUN | NOT RUN |
| Browser Stop followed by the same approved request returning 403, without an effect | NOT RUN | NOT RUN |

The final current-head worker log contains 2,211 messages and 2,210 completions,
counted by unique completed-handler event ids for the seed conversation. The last
message had no completion. Both projections settled at position 4,880. The attempted
SQL count connected after PostgreSQL had stopped, so these counts come from the
retained worker log rather than a final table query. The demo recorder
contained zero effects; approval and execution had not begun. Paid calls: zero.
The [current-head checkpoint trace](seed-checkpoints-rebased-round3.csv) shows continued progress.

The first run's hundred-record burst exceeded its thirty-second projection wait.
A committed real-NATS regression failed at that burst size before the fixture was
changed to twenty records per batch. The final run reported no individual checkpoint
assertion before the launcher stopped. Current-head seed creation completed at
02:03:59.525 UTC; its last record completed at 02:23:12.206. The launcher failed at
the twenty-minute boundary. Its saved error contains only the failed child command,
without timeout metadata.

PostgreSQL used its half-core allocation and was throttled in 1,444 of 1,450 measured
scheduling periods during current-head seeding. Resource limits and deadlines were unchanged.
The separate many-models 503 remains unexplained. See the
[final fix receipt](rework3.md) for the measurements and test-first change.

Startup, service, container and pod logs, screenshots, checkpoint/load samples and
readback files were retained in the private fleet receipts before every teardown.
All four used stacks were stopped with `down.sh` and ultimately reported free.
Only free stand-in providers were used.

## Round-three source

Main moved during qualification. The rebase onto
`c791103b365ced8fd56195ded9d0dcfabf202597` finished. Synthetic prose and the live seed
now use main's existing plaintext event contract; assertions remain intact.
The final fresh attempt tested this rebased source at `2b0528bf9`. Its CORE captures
show that source. Its incomplete seed leaves the complete slice journey FAIL.
Hosted CI passed at that source: [run 44654869357](https://github.com/elewa-git/opencrane-new/actions/runs/44654869357).
The later receipt update changes only documents and captured evidence.

## Reproduction

Wait until both `status.sh --id 1` and `status.sh --id 2` report free, no package stack
is up, and one-minute load stays below six for five minutes. Check every 30 seconds;
stop after two hours if that interval does not occur. Supply the approved Zitadel
credential file through `ZITADEL_KEY_FILE`; its contents must never enter commands,
logs, screenshots or saved events.

Run from this worktree in Bash after the eligibility interval:

```bash
export DEV_STACK_CLAIM_PID=$$
stack_id=$(infra/dev-stack/claim.sh)
export DEV_STACK_ID="$stack_id"
# Install cleanup that saves startup/service logs and screenshots before down.sh.
nice -n 10 infra/dev-stack/up.sh --fresh
STAGE_B_CLAIMED_ID="$stack_id" nice -n 10 node --experimental-strip-types \
  infra/dev-stack/stage-b-live.ts &
tls_pid=$!
# Wait for the launcher's guarded server/models readiness message.
APPROVAL_JOURNEY_ONLY=1 nice -n 10 infra/dev-stack/journey.sh --id "$stack_id"
# Copy startup/service logs, demo-calls.jsonl, approval-readback and screenshots now.
kill -TERM "$tls_pid"
wait "$tls_pid"
infra/dev-stack/down.sh --id "$stack_id"
infra/dev-stack/status.sh --id "$stack_id"
```

Always retain logs before cleanup, including after a failed step. Always run `down.sh`.
The launcher requires the current secondary claim and uses the existing TLS fixture
for `https://mcp.example.test/`. Product network guards remain enabled.

The focused driver seeds 500 messages and matching completion events. It registers
the real demo definition through discovery, reviews `change_delivery_slot` as Ask,
blocks other tools, publishes with the current reviewed revision and waits for the
matching gateway acknowledgement. It scripts the approval-request turn as the existing
approval fixture does; browser decisions and gateway execution use the real services.
Independent demo readback and recorded exact request bytes prove the effect and single
use. A normal browser chat turn first requests and approves its own exact tool call.
Capture its approved, unused state, press Stop, then resend those same bytes with the
already issued pass. The call must be refused without another upstream effect; Ask
alone cannot explain this refusal.

Provider: existing free stand-in. Paid calls: zero. No real-provider attempt was needed
before the setup failure. Whether this driver completes the whole slice remains unproved.
