# Long-chat approval and Stop journey

Date: 20 November 2026 UTC. Builder's own qualification only.

Journey on a fresh dev stack: FAIL

Rebased source: NOT RUN. Finding 4 remains blocking; the PR remains a draft.
No independent review result is claimed.

## Actual fresh attempts

Every startup used `claim.sh` and `up.sh --fresh` on secondary slot 1, after both
slots were free, no package stack was running and load had remained below six
for five minutes. The [availability samples](availability-round3.csv) retain the
observations, including earlier preflight refusals before any startup.

| Receipt identifier | Source | CORE | Focused journey |
| --- | --- | --- | --- |
| `live-20261119T234555Z` | `c14be2419` | PASS, both widths | FAIL: first batch expected 556, observed 516 at thirty seconds; later reached 556 |
| `live-20261120T001755Z` | `8e5056f7a` | FAIL: uploaded-text reply at 1280 px never reached Done within 120 seconds | NOT RUN |
| `live-20261120T003423Z` | `8e5056f7a` | PASS, both widths | FAIL: launcher stopped during seed setup after about twenty minutes |

The qualifying low-load intervals lasted 302, 304 and 305 seconds respectively.
The third attempt started before the original availability deadline of 00:44:57 UTC.
No further claim was made after that deadline.

[Final mobile CORE capture](core-390.png) and
[final desktop CORE capture](core-1280.png) show the successful CORE chat and Stop.
The [earlier desktop failure](core-upload-failure-1280.png) remains recorded separately.
The earlier attempt in [round two](rework2.md) also remains a failure.

## Final focused result

| Condition | 390 px | 1280 px |
| --- | --- | --- |
| CORE chat, reload, Stop, uploads and live-view revocation | PASS | PASS |
| Guarded TLS launcher ready | PASS, shared setup | PASS, shared setup |
| Complete 3,000 earlier messages and their completions | FAIL during setup | NOT RUN |
| Long chat answers with native tool approval and returned result | NOT RUN | NOT RUN |
| Exact forwarded bytes, one use, denial and reload | NOT RUN | NOT RUN |
| Browser Stop followed by the same approved request returning 403, without an effect | NOT RUN | NOT RUN |

The final probe found 2,461 messages and 2,460 completions. The interrupted message
had no completion. Both projections settled at position 5,380. The demo recorder
contained zero effects; approval and execution had not begun. Paid calls: zero.
The [checkpoint trace](seed-checkpoints-round3.csv) shows continued progress.

The first run's hundred-record burst exceeded its thirty-second projection wait.
A committed real-NATS regression failed at that burst size before the fixture was
changed to twenty records per batch. The final run reported no individual checkpoint
assertion before the launcher stopped. The output-file interval was 00:49:22.448–
01:09:32.518; the elapsed time is consistent with its unchanged twenty-minute limit.
The saved error contains only the failed child command, without timeout metadata.

PostgreSQL used its half-core allocation and was throttled in 848 of 849 measured
scheduling periods during seeding. Resource limits and deadlines were unchanged.
The separate many-models 503 remains unexplained. See the
[final fix receipt](rework3.md) for the measurements and test-first change.

Startup, service, container and pod logs, screenshots, checkpoint/load samples and
readback files were retained in the private fleet receipts before every teardown.
All three used stacks were stopped with `down.sh` and ultimately reported free.
Only free stand-in providers were used.

## Current source

Main moved during qualification. The rebase onto
`c791103b365ced8fd56195ded9d0dcfabf202597` finished. Synthetic prose and the live seed
now use main's existing plaintext event contract; assertions remain intact.
Fresh qualification of this rebased source is NOT RUN. The successful CORE captures
above qualify only the source named in the actual-attempt table.

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
infra/dev-stack/up.sh --fresh
STAGE_B_CLAIMED_ID="$stack_id" nice -n 10 node --experimental-strip-types \
  infra/dev-stack/stage-b-live.ts &
tls_pid=$!
# Wait for the launcher's guarded server/models readiness message.
APPROVAL_JOURNEY_ONLY=1 infra/dev-stack/journey.sh --id "$stack_id"
# Copy startup/service logs, demo-calls.jsonl, approval-readback and screenshots now.
kill -TERM "$tls_pid"
wait "$tls_pid"
infra/dev-stack/down.sh --id "$stack_id"
infra/dev-stack/status.sh --id "$stack_id"
```

Always retain logs before cleanup, including after a failed step. Always run `down.sh`.
The launcher requires the current secondary claim and uses the existing TLS fixture
for `https://mcp.example.test/`. Product network guards remain enabled.

The focused driver seeds 3,000 messages and matching completion events. It registers
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
