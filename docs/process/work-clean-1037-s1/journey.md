# Architecture overview: fresh-stack CORE journey

Journey on a fresh dev stack: PASS

17 November 2026 (UTC). Tested head:
`6a4290fd4e6bd7d4e74f17d166053507795ebef6`.
The final evidence commit also wraps long test-fixture strings; their values and
assertions stay the same. Application and library source is unchanged from the tested head.

## Environment and commands

Claimed secondary stack 1 through `infra/dev-stack/claim.sh`. Ran
`infra/dev-stack/up.sh --fresh` under `nice -n 10`, with managed calls enabled
and the stand-in provider. The stack's CORE runner used Playwright from the
installed workspaces against `http://127.0.0.1:25106`, at 1280 px and 390 px.
No real model provider was used. Credentials were supplied only by file reference.

Expected: the unchanged CORE journey passes on a fresh stack while the new overview
and checker remain available in the checkout. Observed: startup and the full CORE
runner exited 0. See the [recorded result lines](core-output.txt).

## Steps and observed results

1. Sign in through Zitadel at both widths. Refuse the wrong organisation, expired
   sessions and hostile logout Origins.
2. Send a message, see the streamed reply and reload. Stop another reply and reload
   again. Keep the completed reply and the stopped partial text at both widths.
3. Upload and preview files. Refuse malware, unsupported types and oversized files.
   One deliberate upload retry per width saves no duplicate file.
4. Open the conversation's desktop viewer. Refuse access without a grant, then grant
   it and show the desktop. Revoke access and clear pixels in 79 ms at 390 px and
   439 ms at 1280 px.
5. Read the requester's action history. Refuse another member and the owner access to
   private history. Show the member's organisation-history refusal at both widths.
6. Save paying-group and assistant spending limits at both widths. Refuse over-limit
   stand-in calls and keep the notice after reload.
7. Verify member and tool-catalogue replay, sign-out token boundaries and reauthentication.
8. Run `infra/dev-stack/status.sh`: processes, services and health checks pass.
   Run `infra/dev-stack/down.sh`: exit 0. Final status reports `free`.

The CORE runner explicitly skips the separate approval journey. Live approval,
real-provider and production installation qualification are NOT RUN in this slice.
The diagrams describe checked source paths; they do not claim those separate journeys passed.

## Screenshots

All four captures were visually inspected. They contain no email addresses,
private paths or credentials.

- [Chat at 1280 px](chat-1280.png)
- [Chat at 390 px](chat-390.png)
- [History refused at 1280 px](history-refused-1280.png)
- [History refused at 390 px](history-refused-390.png)

## Own source checks

PASS under `nice -n 10`: overview check and all 14 checker tests twice;
scoped ESLint with zero warnings; workspace, package and dev-stack typecheck;
event catalogue (174 types); Knip; changelog; README, documentation and link checks;
and Markdown lint. Documentation and privacy checks also cover this receipt.

The first test commit failed because the checker did not exist. Invalid-page tests
then failed against the smallest accepting command. Dashed return arrows and
activation arrows each received a failing regression before their fixes.
The final tests cover the required refusals and the exact accepted limits.
Full root lint and the full root suite were NOT RUN under the requested local scope.
No web source changed, so separate web tests and build were not local gates.
Independent review was not run.
