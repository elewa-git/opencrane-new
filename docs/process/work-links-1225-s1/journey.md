# Chat link journey

Date: 27 November 2026.
Source: `5b9a55243246e811dc2908e13e7736c60a773ea5`.

Focused chat-links journey on a fresh dev stack: **PASS** at 390 px and 1280 px.
The bundled startup journey also passed. A separate standard `journey.sh` run
failed with only a generic failure available in its saved log; it does not replace
the focused journey result.

## Local checks

| Check | Result | Evidence |
| --- | --- | --- |
| Clean dependency installation | PASS | `npm ci` completed. No dependency was added. |
| Changed web tests, twice | PASS | 352 focused checks, then the full web run containing them. |
| All web tests | PASS | 92 files and 1,689 tests. |
| Free model stand-in tests, twice | PASS | Nine checks in each run, including creating the shared file. |
| Typecheck | PASS | All workspaces, package and dev-stack checks; final web and dev-stack checks. |
| Production web build | PASS | Completed with style-budget and vendor warnings. |
| External new-tab fixture, twice | PASS | The browser fixture handles the new tab and confirms no opener. |
| Changed-file ESLint | PASS | No errors or warnings. |
| Projection regression, twice | PASS | 21 database and display checks in each run. |
| Event catalogue | PASS | 175 event types agree. |
| Knip | PASS | No unused code findings; two configuration hints. |
| Changelog and Markdown | PASS | Release note check and markdownlint completed. |
| Read limits and recorded lint limits | PASS | No new whole-stream reads or raised limits. |

The first committed tests failed because bare addresses and files stayed text,
formatted addresses were not links, and browser history did not redraw the app.
Later checks caught code spans with backticks or line breaks, unknown schemes
that report this app's origin, and relative addresses resolved from the wrong page.
Each failed for its expected reason before the correction.
A small browser probe also showed that a page route misses a new tab's first
request. The driver now registers the external fixture on the browser context.
The same probe then passed twice. It was a local fixture check, not a fresh-stack
journey.

The full web run also caught two test problems. A dialog test replaced a read-only
method left by another test. It now uses the existing helper that saves and restores
the original methods. A colleague-chat test checked for a status button that appears
before the response arrives. It now waits for the actual outcome message.

## What was shared or removed

Member and assistant messages share the Markdown parser, link checks, file lookup
and inline rendering. The old member-only text parser was removed. App navigation
recreates the requested page so its existing cleanup ends reads and connections.
Two duplicate focus helpers became one. The dialog test helper moved to shared
test support. Shipped code changed by 457 lines, including the live-check driver
and model stand-in support. Tests and documents are excluded from that count.

## First live attempt

Source: `63050aa91e56b54cd6039270f63e66138f6695dd`.

1. Kept the source work idle through the reserved window.
2. Read the pilot marker and checked secondary availability after 18:00 UTC.
   One read-only status request was mistakenly made for pilot slot 2 while
   identifying the marker. No claim, start or stop was requested for that slot.
   Later checks use only slot 1.
3. Waited for slot 1 to be free and the one-minute load to stay below 6 for five
   minutes. The pilot is excluded from the availability check.
4. Claimed slot 1 at 19:40 UTC and started it with `up.sh --fresh --id 1`.
   The built-in browser checks passed at both widths. Service status was healthy.
5. Ran the link driver. The server completed the turn and published the file,
   but the browser could no longer load that conversation. Its history request
   returned HTTP 503. The driver timed out before capturing either width.
6. Preserved 24 service logs, 16 slot screenshots and 21 baseline browser captures
   in the private receipt. Stopped slot 1 with `down.sh --id 1` and saw it become free.

The root cause was a publication-start record in the public conversation feed.
The catalogue says it stays internal, and the server correctly refuses to display
it. A real PostgreSQL and NATS test reproduced the extra feed row before the
projection rule was corrected. The corrected test and the server display checks
then passed twice: 21 checks per run. A repeat attempt must use another fresh stack.

## Corrected-source live run

Source: `5b9a55243246e811dc2908e13e7736c60a773ea5`.

The permitted availability wait began at 21:17 UTC. Load first stayed below 6
for five minutes, but the slot 1 claim helper kept refusing because its directory
was not owned by this worktree. At 23:06 UTC the helper returned slot 1. The stack
was started with `up.sh --fresh --id 1` and `DEV_STACK_ID=1`. No command was run
against slot 2, the live pilot. Fresh startup passed; its bundled core browser
journey also passed. The stack was healthy before the focused run.

| Check | Result | Evidence |
| --- | --- | --- |
| Fresh secondary stack startup, slot 1 | PASS | Startup completed and service health checks were green. |
| Bundled core browser journey | PASS | Startup checked sign-in, uploads, chat, permissions and both widths. |
| Separate standard `journey.sh` run | FAIL | Launcher returned a generic failure; safe failure category was not recoverable from its log. |
| Chat links, 390 px | PASS | Member and assistant links, punctuation, code, unsafe schemes, keyboard, wrapping, shared files, app navigation, history, reload and refusal. |
| Chat links, 1280 px | PASS | Same checks as at 390 px. |

The focused driver was `nice -n 10 node --experimental-strip-types
infra/dev-stack/chat-links-journey.ts` with `DEV_STACK_ID=1`. It passed all
requested cases at both widths. The member and assistant messages each linked
bare HTTPS and `www` addresses, an email address, and shared `/workspace/artifacts`
paths. The driver also checked same-origin navigation, Back, reload, keyboard
activation, wrapping and unshared-file refusal. It left `javascript:`, `http:`,
`file:`, `data:`, unknown schemes and code unlinked. Screenshots and the small
result JSON are beside this receipt. Startup and service logs from the failed
separate standard journey are retained in the private task receipt on the box.

The pilot was not inspected. The rebuild condition applies to an installation
only when its conversation read tables contain publication-start records; this
run cannot establish whether the pilot has those rows. If an operator confirms
the pilot has affected rows, stop conversation readers and workers, set the documented
`DATABASE_URL` and projection-reader NATS settings, then run:

```sh
npm run replay -- conversations --confirm-conversations-stopped
```

Keep readers stopped until replay succeeds, then reapply any separately configured
table grants before restarting them. The command takes the conversations advisory
lock and rebuilds feed, metadata and participant intervals through a fixed event
position. See [the operator runbook](../../../apps/ops/README.robot.md#rebuild-conversations-offline).

The driver is `infra/dev-stack/chat-links-journey.ts`. It uses real sign-in,
chat commands, computer file publication and file reads with the free model
stand-in. Only the external example website has a browser fixture. It writes
screenshots directly to this receipt folder, outside the slot directory.

Raw command output and service logs stay in the private task receipt. Independent
review is left to the orchestrator.
