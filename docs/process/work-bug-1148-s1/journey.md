# Long-chat approval and Stop journey

Date: 20 November 2026 UTC. Builder's own qualification only.

Journey on a fresh dev stack: FAIL

Round four tested source `2b54bfa1a` on fresh secondary slot 1. CORE failed at 390 px
while waiting for an agent reply to finish during live computer viewing. The 1280 px
CORE and focused long-chat journey were NOT RUN. No further attempt or code fix was
started. The PR stays draft. No independent review result is claimed.

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
