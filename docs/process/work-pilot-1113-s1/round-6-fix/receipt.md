# Packaged dispatcher CPU allocation

Journey on a fresh dev stack: **PASS**. The fresh package used the exact-source
approved application and scanner images for `e64f862c4`. Both slots and all
package namespaces were free and load stayed below six for over five minutes
before claim. The private values file was supplied once by path.

## Fresh package on the revised chart

| Check | 1280 px | 390 px |
| --- | --- | --- |
| Owner sign-in, Secure/HttpOnly session and completed chat | PASS | PASS |
| Admin sign-in, Secure/HttpOnly session and completed chat | PASS | PASS |
| Member sign-in, Secure/HttpOnly session and completed chat | [PASS](member-chat-1280.png) | [PASS](member-chat-390.png) |
| Open an unassigned draft, receive the live assignment and complete chat | [PASS](draft-chat-1280.png) | [PASS](draft-chat-390.png) |
| Wrong-organisation sign-in refusal | PASS | PASS |

The draft opened through New session, Ask your agent, Ctrl+N and Cmd+N before
the assignment. Each width recorded one initial context read and one document
request and received the assignment without reloading.

All nine pre-Helm refusals passed. The claim flow accepted the one-time owner
token and refused a wrong token and token reuse by the owner and member. The
member and owner kept their roles. The wrong-organisation check left the member
count and event position unchanged. The owner used the ordinary claim flow
without the diagnostic readiness observer.

The dispatcher recorded **zero restarts** across 41 samples and in the final
Pod state. The retained dispatcher logs contain zero PostgreSQL pool-acquisition
timeouts and zero computer watcher failures. The live quota was one CPU and
peak average usage over a ten-second sample was 952 mCPU.
[Package and browser checks](package-checks.json).

Startup and service logs were retained before teardown. Package, slot and
temporary test-app cleanup passed. The run used the documented
`OPENCRANE_ACCEPT_DEV_HOST_RISK=accepted-dev-box-366` switch for package-up.
Production F1/F2 host protection remains **PARTIAL** under that local exception.

## Reproduction

The unmodified fresh package at approved product `8fd998ea9` passed installation,
wrong-organisation sign-in refusal at 1280 and 390 px, the owner claim, wrong
token and token reuse. The first owner workspace read returned HTTP 403 at
13:17:37.092 UTC. The reaction that applies the owner's OpenFGA membership
completed at 13:17:37.419 UTC. This run was FAIL, with zero dispatcher restarts
and zero PostgreSQL pool-acquisition timeouts. Later browser checks were NOT RUN.

A separate diagnostic used the existing membership permission handoff before
the owner's first protected workspace request. The first attempt stopped
because its observer assumed a UUID. After switching to the existing
record-id schema, a fresh diagnostic passed owner and admin chats at both widths
and member chat at 1280 px. At 390 px, conversation creation returned HTTP 200 and
all 51 list responses returned HTTP 200. No message request followed. The member
token-reuse and delayed-draft checks were NOT RUN in that diagnostic.

The dispatcher restarted three times. The previous-container logs contained
342, 120 and 28 occurrences of `timeout exceeded when trying to connect`.
The stacks included ordinary reaction transactions, the pg-boss timekeeper and
the queue-settings refresh. All three exits logged `Computer watcher failed`.
Two retained fatal stacks identify a timed-out NATS JetStream stream-info
request in that watcher. Startup and service logs were retained before cleanup.

The packaged dispatcher had a 300 mCPU quota. It spent its full allowance and
was throttled in all 301 scheduling periods across three consecutive ten-second
samples before the first exit. The development dispatcher runs without a
dedicated CPU quota. Both installations use pg 8.16.3 with a ten-connection
pool and 1,000 ms acquisition deadline, and both reached ten connections during
the live samples. Both PostgreSQL servers reported `max_connections` of 100 and
an unlimited dispatcher role. Round 3 had already observed the same restart
and member-send symptoms before #1174.

## Change and source checks

The real Helm render test failed first on `38440ac2c`, with a 300 mCPU dispatcher
limit where it expected 1,000 mCPU. `e64f862c4` gives the dispatcher a 100 mCPU
request and a one-CPU limit. Projection worker resources and the dispatcher's
memory allocation are preserved. The pool settings, reserved connection,
deadlines and retry behaviour are preserved.

- **PASS** for 291 chart tests twice, including the real manifest and projection limits.
- **PASS** for #1174's real PostgreSQL and NATS reserved-connection regression twice.
- **PASS** for workspace, package and development-stack typecheck, event catalogue
  (174 types), Knip, changelog, Markdown and README checks.
- Scoped ESLint found no new issue. The infrastructure JS comparison retained
  one existing function-length finding in the untouched `threePrivatePeers`.
- **PASS** for public privacy and secret checks before the product push.
- **PASS** for both exact-source image approvals. All four artifacts were present and
  unexpired before preparation.
  [Application approval](https://github.com/elewa-git/opencrane-new/actions/runs/45188360085),
  [scanner approval](https://github.com/elewa-git/opencrane-new/actions/runs/45188366632).
- All local lint, test and typecheck commands ran at reduced priority. A full
  root suite was NOT RUN locally.

## Other packaged tickets

- #1162 is affected by the packaged dispatcher contention. Two earlier packaged
  runs recorded 25 and 47 pool-acquisition timeouts, with zero dispatcher
  restarts. The cause of its upload and desktop delays remains unconfirmed.
- #1110 is affected. Its package recorded the same acquisition timeouts with
  the dispatch code later merged in #1174, and one retained previous container
  shows a computer-watcher read timeout. Its provider journey remains separate.

## Fresh development stack

PASS on `e64f862c4`. The stack started fresh through the slot launcher. The
startup journey, status and explicit repeat all passed, with browser checks
at 1280 and 390 px. This included Spending, which failed in round 5. The
dispatcher kept one PID and logged zero pool-acquisition timeouts. PostgreSQL
reported ten dispatcher sessions in 65 of 66 samples. An isolated checkout
kept the pre-existing browser captures in the review worktree intact. Startup
and service logs were retained before teardown, and the slot was released.

Exact-product CI passed all nine jobs. [CI run](https://github.com/elewa-git/opencrane-new/actions/runs/45188370033).
