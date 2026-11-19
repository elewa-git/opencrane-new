# Long-chat approval and Stop journey

Date: 19 November 2026 UTC. Builder's own qualification only.

Journey on a fresh dev stack: FAIL

CORE: PASS at 390 and 1280 pixels. Long-chat approval, execution and Stop refusal:
NOT RUN, because history setup failed before tool discovery. No independent review
result is claimed. The PR remains a draft.

## Fresh secondary attempt

Source: `0e089c95aa1db43ca2f46a7c69c1b2c3a2d5f038`.
Receipt identifier: `live-20261119T200258Z`.
Secondary slot: 1. Started at 20:02 UTC; torn down at 20:23 UTC.

Before claiming, both secondary slots reported free, no package stack was up, and
one-minute load remained below six for 328 seconds. Checks ran every 30 seconds.
Used `claim.sh`, then `up.sh --fresh`, with the default CORE qualification.

| Check | 390 px | 1280 px |
| --- | --- | --- |
| CORE chat, reload and native Stop | PASS | PASS |
| CORE uploads and live-view revocation | PASS | PASS |
| Existing guarded TLS launcher ready | PASS, shared fixture | PASS, shared fixture |
| Seed 3,000 completed earlier messages | FAIL during setup | NOT RUN |
| Discover, review and publish the tool | NOT RUN | NOT RUN |
| Browser approval and exactly one real demo effect | NOT RUN | NOT RUN |
| Long-chat native Stop and next tool call refused | NOT RUN | NOT RUN |

[CORE mobile screenshot](first-core-390.png) and [CORE desktop screenshot](first-core-1280.png)
show the earlier CORE chat and Stop, not a long-chat approval outcome.

The seed failed at `waitForApprovalHistory` with the existing assertion that history
must reach the conversation projection. The retained worker log shows successful
seed records and no handler error. It does not contain the expected and observed
checkpoint values, so the delay's cause is not established. Added those diagnostics
and batch progress for the next fresh run. No longer deadline or retry was added.

Startup, service and container logs and all screenshots were copied into the private
fleet receipt before `down.sh`. The final slot status was free. No owner stack was
used. Another secondary claim later prevented an immediate new fresh run.

The earlier first-round attempt failed before approval with gateway 404. Its result
remains recorded in [the first fix receipt](rework1.md). It is not evidence of this
round's source passing the slice journey.

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
