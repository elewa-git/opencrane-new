# #1221 packaged journey receipt

Run date: 27 November 2026. Fresh packaged slot: 1. Tested product commit:
`3a9e760e4fbead2cb1b49dae36ea2c18157e6ecd`.

## Verdict

**PARTIAL — journey blocked before personal chat.** The packaged installation and
provider setup completed. The member's four onboarding answers were saved, and
the approved persona names the assistant Aster. On a later sign-in, both
`/workspace` and `/welcome` reported “Your access has changed”; the selected
personal conversation was unavailable and the New session control was disabled.
The assistant chat prompts were not sent. No real model response, deck, or fetch
result was produced.

The member can see the assigned personal workspace shell, but cannot open a new
session. The receipt includes the unavailable workspace at 1280 px and the earlier approved
persona. A 390 px screenshot was not captured.

## Access failure investigation

Investigated on 27 November 2026, starting at `dac34cba7`. The fetched main commit
was `d592e9890742a40abf69d61f81a1c4bcb4297952`, already included in this branch.
No rebase was needed. The comparison finished and the development branch was restored.

**PASS — the refusal also occurs on main when the journey selects another account.**
The original onboarding commands supplied `DEV_STACK_ID=1`. The later
`live-journey.mjs` and `probe-member.mjs` launches omitted it. Their sign-in helpers
load configuration and test users from the stack chosen by that variable. Without
it, `identity.ts` selects `owner`, although both scripts still open slot 1's web
address. The selector was checked without opening any private configuration file.

The saved server log shows six `GET /api/chat` requests returning 403, starting at
19:11:19 UTC. Onboarding entry requests also returned 403. The member worker log
shows the survey answers and persona approval, with no later member removal or
role change. No conversation creation or chat message was sent. These requests
were refused before `approvedPersonaReader`, `assistantTurnIdentity` or the
computer's `readAssistantIdentity` could run.

The HTTP test uses real disposable NATS, PostgreSQL and OpenFGA.
[The check results](access-checks.json) record the tested commits and local gates. It projects a
joined member and compares two signed-in accounts in the same organisation:

| Check | This branch | Main |
| --- | --- | --- |
| Expect chat access after selecting the other stack's account | FAIL: expected 200, received 403 | FAIL: expected 200, received 403 |
| Select the joined slot member's account | PASS: chat returns 200 | PASS: chat returns 200 |
| Other account signs in, then reads chat and onboarding | PASS: sign-in returns 200; protected reads return 403 | PASS: same results |
| Render the protected read's 403 in the workspace | PASS: access-changed message and disabled New session | PASS: same message and disabled control |

The failing test is reproduced by running `journey-identity.test.ts` with
`JOURNEY_TEST_SUBJECT=other-stack-subject`. With the default joined account, both
HTTP tests pass. `provisioning.spec.ts` checks the exact message and disabled
button. Assertions and access checks were kept intact.

The comparison points to the previous journey's account selection. It does not
show a product regression in this PR or the accepted-message receipt problem
reported in #1215. No product fix was made. Work stopped after the baseline comparison, as requested.
A fresh packaged rerun is **NOT RUN**. No secondary stack was claimed, changed or
stopped. The brief slot wait was cancelled because the baseline comparison calls
for a stop, rather than treating a busy slot as a blocker. Any later journey must
supply `DEV_STACK_ID=1` to every browser script, including sign-in probes.

The original service logs remain outside the repository. Copies of
`server-676b55779c-7kmjz.log` and `worker-members-7948cff9df-hzrct.log` were kept with
`account-context.json`, `branch-identity-red.log`, `main-identity-red.log`,
`branch-identity-green-1.log`, `branch-identity-green-2.log`,
`main-identity-green.log`, `web-reproduction-1.log`, `web-reproduction-2.log`
and `main-web-reproduction.log`. These files contain the detailed local evidence.

## Steps and results

| Step | Result | Evidence |
| --- | --- | --- |
| Rebase on current `origin/main` including #1216; push corrected head | PASS | Product commit `3a9e760e4fbead2cb1b49dae36ea2c18157e6ecd` |
| Application package approval for tested product commit | PASS | Run `46047237181`; approval and image artifacts present |
| Scanner package approval for tested product commit | PASS | Run `46047241881`; approval and image artifacts present |
| Fresh slot-1 packaged install and package check | PASS | Package installed in slot 1; no slot 2 or pilot changes |
| Runtime gateway ConfigMap | PASS | `http://10.43.161.221:43000` |
| Member onboarding survey, all four answers | PASS | Answers saved during setup |
| Approved persona with assistant name Aster | PASS | [Approved persona screenshot](persona-approved-1280.png) |
| Complete saved welcome and enter personal chat | FAIL | Welcome and workspace both showed access changed; New session disabled |
| Memory-off personal chat at 1280 and 390 px | NOT RUN | No chat turn could be started |
| Assistant introduces itself as Aster, not Codex | NOT RUN | No chat turn could be started |
| Truthful capabilities: shared files, software installs, no internet, no browser control | NOT RUN | No chat turn could be started |
| Create and share a short slide deck | NOT RUN | No chat turn could be started |
| Graceful refusal to fetch `https://example.com` | NOT RUN | No chat turn could be started |

[Workspace unavailable at 1280 px](workspace-unavailable-1280.png)

## Spend and stack handling

Recorded spend was **1 euro cent** (`settledCents: 1`) across one settled event.
This was provider verification/setup; no chat prompt was sent. The reserved total
was 1 cent. Amounts are integer cents from `budget-dev` events.

Package-up used the documented dev-host risk override
`OPENCRANE_ACCEPT_DEV_HOST_RISK=accepted-dev-box-366`. The package failure from
the earlier stand-in-only attempt was recorded safely as a fleet-stand-in refusal;
its raw failure record and the fresh stack service logs were kept outside the
repository. The fresh provider-mode install and `package-check` then passed.

No “Run interrupted”, 502, or `127.0.0.1:8080/v1/responses` error appeared. The
ConfigMap gateway value was checked after the access failure and remained the
service address shown above.

## Checks

| Check | Result |
| --- | --- |
| Application package approval on product commit | PASS |
| Scanner package approval on product commit | PASS |
| Fresh packaged install and package check, slot 1 | PASS |
| Onboarding answers and approved persona | PASS |
| Personal chat access after welcome | FAIL |
| Real-model chat prompts and Memory-off verification | NOT RUN |
| Desktop/mobile chat screenshots, deck sharing, fetch refusal | NOT RUN |
| Mobile screenshot | NOT RUN; stack released after access failure |
| Paid chat usage | NOT RUN; recorded setup spend is 1 cent |
| Hosted CI for the tested product commit | FAIL; shard 1 setup hook timed out and shard 3 kubectl process was terminated |
