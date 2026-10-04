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

Fresh deployed-silo installation, real provider sign-in and hosted CI: **NOT RUN**.
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
