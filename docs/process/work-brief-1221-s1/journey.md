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
session. The receipt screenshots show the unavailable state at 1280 and 390 px.
The earlier approved-persona screenshot is also included.

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
