# Chat link journey

Date: 27 November 2026.
Source: `446ea3490e1e57efba3e5be6cb7e628a661fbd19`.

Journey on a fresh dev stack: **NOT RUN** for the corrected source.
The first attempt on the earlier source failed. Its root cause is fixed and tested,
but the repeat run could not claim the only available secondary slot within the
permitted two-hour availability wait. The capability still needs live qualification.

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

## Corrected-source availability wait

1. Repeated the local checks after correcting the publication projection.
2. Waited for slot 1 again. Slot 2 is the live pilot and was excluded.
3. Kept the total availability wait within two hours across both attempts.
   The box was reserved until 18:00 UTC; availability checks began after that.
4. Tried to claim slot 1 when it was free and the load had stayed below 6 for
   five minutes. The slot lock refused the claim. An attempt at 21:08 UTC was
   followed by the required two-minute wait.
5. Another task started a package in slot 1 and held its lock. The read-only status
   check then waited for that lock. Ended only this task's wait helper and its
   pending status check at the availability deadline. No second stack was claimed,
   started or stopped by this task.

The refusal came from the secondary slot lock in `infra/dev-stack/run.sh`.
No guard was changed or bypassed. No link-specific screenshot was captured, so
neither width, keyboard activation nor file-opening behaviour has a live PASS.
The first stack was already torn down before this wait. No stack remains owned
by this task.

## Remaining live work

Run `chat-links-journey.ts` against this corrected source on a fresh secondary stack
at 1280 px and 390 px. It must check both message types, keyboard use, file access,
unsafe addresses, code, wrapping, app navigation, Back, reload and unshared-file
refusal. Capture the screenshots and release the claimed stack.

Existing installations whose read tables contain publication-start records need
the documented offline conversation rebuild with readers and the worker stopped.
No existing installation or pilot was rebuilt here.

The driver is `infra/dev-stack/chat-links-journey.ts`. It uses real sign-in,
chat commands, computer file publication and file reads with the free model
stand-in. Only the external example website has a browser fixture. It writes
screenshots directly to this receipt folder, outside the slot directory.

Raw command output and availability samples stay in the private task receipt.
The availability file is `slot-wait.jsonl` and `slot-wait-second.jsonl`; gate outputs are named
`links-1225-*.log`. They are not committed. Independent review is left to the
orchestrator.
