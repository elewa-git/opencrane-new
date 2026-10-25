# P3-18 — capture and reopen an authorised screenshot

4 October 2026. Branch `work/p3-18-screenshots`, base
`f88c93458246fa38315e7d390320d3d2a0882145`. Implements issue #59 under #41 and D23.

## Outcome and architecture

The viewer's Screenshot button captures one PNG through the existing authenticated
read-only desktop transport. Participants also need the current shared-desktop grant.
The existing inspection, 20 MiB size limit, scan, private storage and file command
handle the bytes. The event records SHA-256, conversation, author, computer,
generation, capture time and dimensions. One conditional append remains authoritative;
file and conversation projections rebuild it. No runtime dependency, public URL,
continuous recorder or separate artefact service was added.

Screenshots appear as thumbnails in the transcript and the session panel's Screenshots
group, and use the existing expanded preview/download after reload. Other participants
can read them with current conversation permission. Ordinary uploads retain their
existing creator restriction. Capture retries reuse their key; a failed capture or
scan never becomes a saved card.

## Evidence

Environment: Node 22.23.3, ordinary Docker fixtures on the existing daemon,
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`. Fixtures create
isolated database schemas, NATS processes, OpenFGA, Kasm desktop, MinIO and ClamAV.
No owner-stack changes, daemon startup or Docker/network configuration changes.
The computer fixture uses `ocn-upload-computer:test`; its digest is recorded in the
browser receipt. This is local source and disposable-service evidence, not a deployed
fresh silo.

- TDD API red: missing capture endpoint returned 404; green: one scanned PNG event,
  replayable list, transcript and identical reopened bytes.
- TDD participant red: preview refused a newly added participant; green: permitted
  screenshot preview and participant capture with an audience grant.
- TDD Playwright red: the real Kasm viewer had no Screenshot button. Browser green: both widths passed, including terminal rejection followed by a
  new successful capture. Reopened PNG pixels exactly match the real viewer.
- Three concurrent duplicate commands and a later retry yield one PNG event.
  Golden RGB pixel bytes and the promoted PNG SHA-256 are checked independently.
- Preview/download refusal checks cover participant/member removal, foreign
  organisation, expired sessions and a URL reopened without a session.
- Refusal checks cover absent/expired sessions, foreign silo, nonparticipant,
  incorrect Origin/CSRF marker, arbitrary URL/path body, oversized desktop, scan
  unavailability, grant revocation during scan and computer generation replacement.
  Infected captures append one rejection and store no bytes.

The [browser receipt](p3-18-live/receipt.json) records the runtime image digest,
source base plus source-files SHA-256, and equal decoded-pixel digests at both widths.
Safe examples: [desktop progress](p3-18-live/progress-1280.png),
[phone thumbnail](p3-18-live/thumbnail-390.png),
[phone preview](p3-18-live/preview-390.png) and
[phone failure](p3-18-live/error-390.png).

Local command logs and original browser artefacts are under `/tmp/p318-*.log` and
`apps/computer/.state/p318/` on the builder host. The repeatable browser test compares
SHA-256 of decoded RGBA pixels from the real viewer and reopened PNG, and captures
progress, thumbnail, expanded preview and failure at both widths.

At this initial source checkpoint, fresh deployed-silo installation, real provider
sign-in and hosted CI were **NOT RUN**. The final secondary-stack receipt below
records later qualification separately.
The capture control is the explicit member path permitted by D23; adding a new
assistant tool or continuous collection is outside this change.

## Review and gates

Independent adversarial review, two passes: **PASS**, no remaining code blockers.
The first pass found terminal-rejection retry state, missing permission documentation,
failed gate evidence and a browser selector targeting the hidden panel copy. The
second verified their fixes and additional concurrent/revoked-reader checks.

| Check | Result |
| --- | --- |
| Focused screenshot and ordinary-upload integration tests | PASS, 9 tests |
| Real Kasm Playwright journey at 1280 and 390px | PASS, decoded pixels, progress, reload, thumbnails, both preview entries, scan failure and rejection recovery |
| `npm run check:events` | PASS, 85 event types |
| `npm run typecheck`, all workspaces | PASS |
| `npm run build -w apps/web` | PASS, existing bundle/style/CommonJS warnings |
| `npm run test -w apps/web` | PASS, 60 tests |
| `npm run lint` | PASS, all six checks; existing warnings |
| `npm test -- --maxWorkers=2` | PASS, 77 files / 1,377 tests; 4 files / 15 conditional tests skipped |

The full root suite ran for 876.27 seconds with two workers. Conditional live
qualification tests remain skipped in that command; the screenshot browser test
was explicitly enabled and passed separately. Final lint passed all six checks.

## Final rebase and secondary-stack qualification — 4 October 2026

The owner reported review approval (**LAND**) at `0e2871f`. Rebase onto
`origin/main` at `65364a0` completed without conflicts, producing `bd938b5`.
`git merge-base --is-ancestor origin/main HEAD` passed and no rebase remained
in progress. Main's exact-subject authority reads are retained; the reviewed
screenshot runtime code needed no correction.

Secondary stack **1** was reserved with `infra/dev-stack/claim.sh`, then all
stack operations used `DEV_STACK_ID=1` and
`ZITADEL_KEY_FILE=<worktree>/.keys/.zitadel-key`. The browser
origin is `http://127.0.0.1:25106`, namespace `opencrane-dev-1`, using the existing
Docker daemon and k3d cluster. Only this claim's resources are managed. No daemon
or host-network change, new dependency or paid call is used. Core assistant
journeys use the existing stub provider.

The repeatable `infra/dev-stack/screenshot-journey.ts fresh|repeat` uses real
Zitadel member and owner sessions, the deployed server and the configured
Angular proxy. Normal fixtures append desktop grants through the event store
and show a known desktop window. The participant creates a conversation through
the API, opens its viewer, clicks **Screenshot**, opens the image from the
conversation and session panel, and repeats both previews after reload. The
retained run also checks the fresh run's screenshot when one was saved.
Downloaded bytes must
match the saved event's SHA-256. A signed-in non-participant receives a desktop
grant too: viewing, capture and image access must still return **403**, with
no additional saved screenshot event. Receipts bind source, journey SHA-256,
computer image digest, stack identity, capture time and result at both widths.

The final **retained-stack screenshot journey passed** at
[390px](p3-18-live/repeat-390.json) and
[1280px](p3-18-live/repeat-1280.json). Captures took **5,061 ms / 6,065 ms**
(390px / 1280px); each conversation has exactly one saved PNG event, and its
downloaded bytes match that event's SHA-256. Both UI entries and both previews
passed before and after reload. The real signed-in owner was a non-participant
with a desktop grant and received **403** for viewing, capture and PNG access
at both widths; the refusals saved no additional screenshot. Safe screenshots:
[390px viewer](p3-18-live/repeat-viewer-390.png),
[1280px viewer](p3-18-live/repeat-viewer-1280.png),
[390px reloaded conversation](p3-18-live/repeat-reloaded-conversation-390.png),
[1280px reloaded conversation](p3-18-live/repeat-reloaded-conversation-1280.png),
[390px panel](p3-18-live/repeat-reloaded-panel-390.png) and
[1280px panel](p3-18-live/repeat-reloaded-panel-1280.png).

The focused retained run took **146.04 s** including real sign-in/out probes.
`infra/dev-stack/down.sh --id 1` passed in **43.97 s**, removed both secondary
namespaces, volumes and claim directory, and released the slot. The initial
owner marker and resources were not managed. No fresh image existed for the
extra persistence-across-startup check, so it is **NOT RUN**. Full fresh-install
screenshot qualification remains **PARTIAL** under #77 despite the retained
participant/refusal journey passing. Hosted CI, managed-cluster and paid-model
qualification are **NOT RUN** in this round.

The first complete fresh startup failed after **479.00 s** in the existing
PDF-upload journey, before live-view: the Willow-47 answer was rendered but
`browser-upload.ts:112` timed out waiting for **Done**. The model container was
observed exited with code 1 and no OOM flag; no root cause is claimed. The
[390px failure screenshot](p3-18-live/fresh-core-failure-390.png) is retained.
The one fresh rerun failed after **755.98 s**: the
[390px core viewer receipt](p3-18-live/fresh-core-viewer-390.json) passed
(revocation cleared pixels in **754 ms**), but `browser-live-view.ts:53`
timed out waiting for **Viewing** at 1280px. Its
[failure screenshot](p3-18-live/fresh-retry-core-failure-1280.png) shows
**Disconnected**. This is recorded under the existing #77 live-view reliability
limit; no root cause is claimed and no viewer deadline was relaxed.

The separate fresh screenshot journey completed real sign-in and its refusal
checks, then timed out in the 390px decoded-framebuffer check before capture;
1280px capture was not reached and is **NOT RUN** on fresh startup. Its
[390px screenshot](p3-18-live/fresh-failure-390.png) shows **Access changed**.
Fresh screenshot capture is **FAIL**, and persistence of a fresh screenshot
across plain startup is **NOT RUN** because no fresh image was saved.
The plain startup's first attempt failed in `browserSessions` at **refusal
checks** after **122.48 s**; that helper hides the underlying exception, so no
cause is asserted. The plain rerun failed after **302.85 s** at the existing
390px viewer's **Viewing** wait (`browser-live-view.ts:53`), with its
[failure screenshot](p3-18-live/repeat-core-failure-390.png) retained.
Both complete startup modes are **FAIL** after one retry each.
Private command logs and diagnostics stay in
`/tmp/p318-final/`; credentials and private logs are not committed.

## Final source gates

Node **22.23.3**, this worktree, with
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres` and
`MODELS_REAL_CALL=0`. No root-suite retry or timeout override was used.
The passed live receipts retain the tested journey's SHA-256
`cad67fd884cec9e7622119441c00ea3fab7697c57e5801cec01f4dcb55e288e5`.
After live qualification, the extra infrastructure typecheck found three
Playwright responses with ambiguous inferred types. Explicit `APIResponse`
annotations corrected those diagnostics; the final journey's SHA-256 is
`d30ef85df817079b1051a4410a0001426cf9016772c1d92c5c4f4ac8780f2f5e`.
Node's `stripTypeScriptTypes(..., { mode: 'transform' })` produces identical
JavaScript before and after those type-only corrections. Screenshot runtime
code is unchanged from the rebased review-approved source.

| Command | Result | Seconds |
| --- | --- | --- |
| `MODELS_REAL_CALL=0 npm test -- --maxWorkers=2` | PASS; 80 files / 1,385 tests; 4 files / 15 conditional tests skipped | 1,423.57 |
| `npm run typecheck` | PASS; all workspaces | 161.95 |
| First `npx tsc -p infra/dev-stack/tsconfig.json --noEmit` | FAIL; three inferred response types | 25.26 |
| Final infrastructure typecheck | PASS; explicit Playwright response types | 15.48 |
| `npm run check:events` | PASS; 85 types agree | 0.89 |
| `npm run build -w apps/web` | PASS; existing bundle/style/CommonJS warnings | 19.69 |
| `npm run test -w apps/web -- --watch=false` | PASS; 11 files / 60 tests | 30.53 |
| `npm run lint` | PASS; all six checks; existing warnings | 184.08 |

The [final receipt](p3-18-live/qualification.json) records command results and
timings. The optional paid-provider and additional Kubernetes/browser suites
remain skipped in the root command; this round separately exercised the deployed
screenshot path with real Zitadel sign-in. Hosted CI is **NOT RUN** here.
