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

The orchestrator checked the live pilot read table read-only at 01:33 UTC on
28 November 2026. It found **0** `agent.file_publication_started` rows and no
`agent.file%` rows at all. The pilot needs no rebuild for this issue today.
This check was supplied by the orchestrator; this task did not access the pilot.

History reads now skip publication-start rows already saved by older workers.
Other installations do not need a rebuild to keep these conversations readable.
An operator may still remove stale rows with an offline rebuild. That requires
stopping conversation readers and workers and setting the documented
`DATABASE_URL` and projection-reader NATS settings before running:

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

## CI corrections, 28 November 2026

Source: `e40358bcf3370c36b8f81815edcf70554d3f2a0b`.

The two reported browser failures came from tests assuming that only assistant
replies used `oc-assistant-markdown`. Member messages now use that renderer too.
The Mermaid test selected the first assistant reply, which had two diagrams,
when it meant to select the second reply. The sign-out test read the member's
question while waiting for private text. Both failures reproduced locally.

The browser checks now select the articles labelled “Agent reply”. The Mermaid
check keeps its strict image lookup, exact diagram counts and network refusals.
The sign-out check keeps both tab scenarios, disconnection and late-reply checks.
The private-reply memory and display checks use the same article label. They also
check that the saved question remains after the private reply disappears.
The memory check starts observing after the saved question renders, so it still
requires all three private operations to cancel. Both its collection checks and
its deliberate retained-callback failure remain in place.

The failed hosted run also exposed a missing packaged import. The model stand-in
imports `chat-links-model.ts`, but the Docker context excluded that file.
The source import check and a real Docker build both failed for this reason.
The context now includes that exact helper. The image checks require it and allow
it in the small list of development files that ship.

| Check | Result | Evidence |
| --- | --- | --- |
| Original browser failures | FAIL, reproduced | Both reported failures occurred in `browser-red.log`; sign-out also failed in `signout-red.log`. |
| Original packaged import | FAIL, reproduced | `package-red.log` names the missing helper; `context-red.log` shows Docker refusing to copy it. |
| Real Docker context, twice | PASS | Both builds copied the required files and compared their contents with the source. |
| Packaged source imports, twice | PASS | The recursive import check found every required development file in the context. |
| Web unit tests | PASS | 92 files and 1,689 tests; 71.44 seconds. |
| Other web source tests | PASS | Four files and 11 tests. |
| All web browser and source tests | PASS | Six files and 17 tests; 429.71 seconds. This includes the two reported browser files. |
| Both reported browser files, second run | PASS | Two files and six tests; 476.15 seconds. Both runs include sign-out, private memory collection, the deliberate memory-leak failure and private-reply display. |
| Production web build | PASS | Existing style-budget and vendor warnings remain. |
| Typecheck | PASS | All workspaces, package and dev-stack checks completed. |
| Event catalogue | PASS | 175 event types agree. |
| Changed-file ESLint | PASS | No errors or warnings in files covered by the repository's ESLint configuration. |
| Knip | PASS | No unused code findings; two existing configuration hints. |
| Changelog and Markdown | PASS | Both checks completed. |
| Fresh journey in this correction | NOT RUN | Link rendering is unchanged. The focused fresh-stack journey above remains PASS at 390 and 1280 px. |
| Full application image archive locally | NOT RUN | The Docker context was tested directly; no complete application image was built locally. |

Raw output stays in the private task receipt. No development stack was claimed
or changed during these corrections.

## Existing-install history correction, 28 November 2026

Source: `240c3dc30128f534a78609e89704540e7e30c7a6`.
Fetching `origin` confirmed that `origin/main` at `d592e9890` was already an
ancestor of this branch. No rebase was needed.

The new database fixture recreates a publication-start row saved by an older
worker. Before the fix, all four HTTP history modes returned 503: the full read,
`since`, tail and older-page reads. The failing tests were committed first in
`bc805fd10`. Raw output is retained as `stale-history-red.log`.

The existing shared row filter now skips that internal event before the server
checks display data. Both forward reads and older pages use this filter, as do
live chat reads. The response keeps the saved newest position even when the last
row is hidden. The worker still prevents new internal rows, and the projection
test now checks the stored table directly as well as its readable output.
The display test still requires internal publication details to be refused.
The HTTP tests also require an unauthorised user to receive 403.

The first combined run caught interference from the new fixture: its extra chat
changed the existing test that lists exactly 60 sessions. The new fixture now
starts in its own test group after those existing tests. No count assertion was
changed. Raw output is retained as `stale-history-green-1.log`.

The link parser comments explain why app links stay on the current origin and
why computer file paths use the shared-file viewer. The navigation comment
explains why Angular needs an explicit `popstate` after `pushState`. These are
comment changes; the existing link and navigation tests check their behaviour.

| Check | Result | Evidence |
| --- | --- | --- |
| Changed server, display and projection tests, twice | PASS | 31 tests per run; 51.76 and 56.44 seconds. |
| Link and navigation tests, twice | PASS | 14 tests per run; 12.63 and 12.48 seconds after bundling. |
| Related HTTP, streaming and legacy replay tests | PASS | Eight tests; 38.48 seconds. |
| Closed-chat history, paging, sockets and replay | PASS | Two selected tests; 51.76 seconds. The other 67 tests were not selected. |
| Repository typecheck | PASS | All workspaces, package and dev-stack checks completed. |
| Event catalogue | PASS | 175 event types agree. |
| Knip | PASS | No unused code findings; two existing configuration hints. |
| Changelog, read limits, recorded lint limits and package READMEs | PASS | All checks completed. |
| Changed-file ESLint and Markdown | PASS | No ESLint warnings; Markdown checked 610 files. |
| Public privacy and secret scans | PASS | Tracked text and the branch changes were checked before push. |

The added access assertions were checked by temporarily bypassing the final
history access check. All four tests failed at their required 403 assertion:
without that check, the existing participation refusal became 503. The original
source was restored without a diff, then all four tests passed again in 20.10
seconds. Raw output is in `fix2-access-mutation.log` and `fix2-access-restored.log`.

Fresh journey for this correction: **NOT RUN**. The read change removes only an
internal record that the chat UI cannot display. It changes no displayed row,
link, navigation or API shape. The focused fresh-stack journey above remains
**PASS** at both widths on its recorded source. No dev stack was claimed.
