# Fresh development stack journey

## Fresh CORE rerun

**PASS** on 27 November 2026 at `495a4b475fabde9ebf7774a9db27b07d359ee24f`.

Slot 1 was free and one-minute load stayed below 6 for five minutes before
reservation. The one default `infra/dev-stack/up.sh --fresh --id 1` run started
at 06:31:55 UTC with the stand-in model. Default owner setup and website
readiness passed. The run took 15 minutes 53 seconds including teardown.

| Browser width | First reply streamed | First reply completed | CORE |
| --- | ---: | ---: | --- |
| 1280 px | 5.562 s | 8.312 s | PASS |
| 390 px | 12.838 s | 15.112 s | PASS |

The one-minute load peaked at 33.40 during the run. The earlier 30-second
streaming-indicator timeout did not recur. Both widths passed chat and
reload, stopping a reply, PDF upload and preview, and desktop access
and removal. The launcher also passed private history, spending, sign-out,
scanner refusal and projection replay checks. Slot 1 reported healthy,
then free after `infra/dev-stack/down.sh --id 1`.

| Evidence | 1280 px | 390 px |
| --- | --- | --- |
| Saved and stopped replies | [Workspace](screenshots/core-workspace-1280.png) | [Workspace](screenshots/core-workspace-390.png) |
| Desktop access removed | [Cleared view](screenshots/core-conversation-revoked-1280.png) | [Cleared view](screenshots/core-conversation-revoked-390.png) |

Private run records include `slot-wait.log`, `host-load.log`, `startup.log`,
`status.log` and `down.log`. A separate token-claim run was **NOT RUN**.

## Rebased run

**PARTIAL** on 27 November 2026. The rebased source was
`5e76409198cbd17950dddcf99564ce28a2c2ba73`, based on `f70213d5f`.

1. The one-minute host load stayed below 6 for five minutes before slot 1 was
   reserved with `infra/dev-stack/claim.sh --id 1` at 05:24 UTC.
2. `infra/dev-stack/up.sh --fresh --id 1` saved the first ownership record,
   confirmed Owner access and brought the website up. **PASS** for default
   owner setup. `infra/dev-stack/status.sh --id 1` reported healthy.
3. The default browser checks (CORE) **FAIL**. The browser waited 30 seconds
   for the first chat reply's streaming indicator. The check stopped before
   the full checks at 1280 px and 390 px could finish. Startup and service
   logs were saved before the stack was reset.
4. Start fresh on the same slot with `DEV_OWNER_BOOTSTRAP=0` and
   `infra/dev-stack/up.sh --fresh --id 1`. The claim page opened after
   sign-in through Zitadel. A valid token returned HTTP 201. The worker saved
   one ownership record, the member record showed Owner and OpenFGA
   allowed Owner access. **PASS** for the token claim.
5. Reusing the token was refused as already used. A second user was refused
   because the silo already had an owner. The event log held one first-owner
   claim. Slot 1 reported healthy and then free after
   `infra/dev-stack/down.sh --id 1`.

The rebased run logs are `startup.log`, `default-service-last-error.log`,
`default-status.log`, `token-startup.log`, `token-journey.log`,
`token-status.log` and `down.log`.

A further CORE run was **NOT RUN**. The host load left too little time to
finish another run within the task limit.

## First run

**PASS** on source `0f9be67e4120884482b26e527a5dee686cd14490`, based on
`c6c8604db`. Slot 1 started with default owner setup and the stand-in model.
The default browser checks passed at 1280 px and 390 px. They covered chat and
reload, stopping a reply, PDF upload and preview, desktop access and removal,
private history, spending, sign-out and projection replay. The scanner refused
EICAR, a scanner test file.

A second fresh start on the same reservation accepted a valid first-owner
token, saved one ownership record and gave the claimant Owner access. The
token was refused on reuse. Slot 1 reported free after teardown. The branch
was then rebased after `main` changed desktop viewing and uploads.

| Evidence | 1280 px | 390 px |
| --- | --- | --- |
| First run saved and stopped replies | [Workspace](screenshots/workspace-1280.png) | [Workspace](screenshots/workspace-390.png) |
| First run desktop access removed | [Cleared view](screenshots/conversation-revoked-1280.png) | [Cleared view](screenshots/conversation-revoked-390.png) |
| Rebased run token confirmation | [Owner confirmation](screenshots/token-claimed-1280.png) | [Owner confirmation](screenshots/token-claimed-390.png) |

JetStream tests covered the competing writes. Development startup waited
through five competing writes, read membership again and saved one owner
list. The token claim worker saved ownership in one delivery after two
simulated six-second membership reads and one real competing write.
