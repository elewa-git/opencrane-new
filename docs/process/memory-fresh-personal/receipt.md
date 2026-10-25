# Personal memory qualification

25 October 2026. Part of #94. Part of #95. Both remain PARTIAL.

`git fetch origin` and rebase completed on `4b72856ac`, including #688
`f01ee18f7`. The earlier prerequisites are #646 `59a81b70f` and #641 `105071aaa`.
One secondary slot, number 1, was claimed through `infra/dev-stack/claim.sh`.
The journey used empty membership history, real SSO and the local model stub.
The setup credential was supplied as a path through `ZITADEL_KEY_FILE`.
Contact details and browser sessions stayed in private slot files. Key folders
belonged to the slot; no private memory custody files were inspected.
No product, Stage B or authority-test files changed.

## Earlier attempt

The original run on `105071aaa` passed SSO and owner claim, then failed its first
Memory load with HTTP 503. Later read-only requests returned 200. Writes, recovery,
restart and rebuild were NOT RUN then. The original [observations](observations.jsonl),
[safe request log](scopes-log.json) and four pictures remain unchanged.
The original phone failure picture shows a closed panel; its later phone picture
caught an opening transition. Neither establishes a phone layout pass.

The first checker tests failed because their module did not exist. They were
committed before implementation. The previous run passed eight checker tests twice,
438 event security tests, CI test selection, lint, typecheck, event catalogue,
Knip, documentation and changelog checks. Its slot and disposable database were released.

## Rerun results

[Original observations](rerun/observations.jsonl) retain the server replies and times.
[Acceptance input](rerun/acceptance.json) contains the original receipts and readbacks.
The desktop collector uses browser controls. Temporary follow-up collectors use the
same real browser session for phone recovery, authenticated reads and retained restarts.
They never append business events directly.

| Step | Result | Observed outcome |
| --- | --- | --- |
| Empty install, SSO and owner claim | PASS | No members before claim; browser confirmed the owner. |
| First Memory load | PASS | First scopes request returned 200 with personal memory. |
| Save a personal fact | PASS | Browser showed Saved; original receipt has revision 1. |
| Search and open | PASS | The garden fact opened with Edit available. |
| Correct on desktop | PASS | Accepted revision 2; refreshed text appeared before Forget. |
| Forget on desktop | PASS | Accepted revision 3, hidden; list no longer showed the fact. |
| Original command receipts | PASS | GET returned the original change ids and revisions. |
| Cleanup completion | FAIL | Correction cleanup became unavailable; forgetting remained pending. |
| Lost accepted reply at 390 | PASS | One real save reply was dropped; Check status sent GET only. |
| Correct at 390 | PARTIAL | Revision 2 was accepted, but its detail refresh returned 503. |
| Forget at 390 | NOT RUN | The failed detail refresh removed the Forget control. |
| Another joined member's HTTP access | PASS | Owner list, surviving detail and forgotten detail each returned 404 without text. |
| Another member's Memory screen | PARTIAL | The collector lost the response body during navigation; no screen pass is claimed. |
| Reload reads | PASS | Forgotten detail said forgotten; only the surviving revision 2 was listed. |
| Reload pictures | PARTIAL | Desktop search showed no match; the separate phone capture timed out. |
| Retained server restart | PASS | Both widths read revision 2 and no forgotten text; browser searches showed no match. |
| Offline rebuild | PASS | Readers, dispatcher and memory worker stopped; event position stayed 51; model calls stayed zero. |
| Readback after rebuild | PASS | Both widths read the retained revision 2 and forgotten detail; browser searches showed no match. |
| Complete acceptance checker | FAIL | The unchanged checker rejected incomplete cleanup in the saved live proof. |
| Governed MCP recall and native memory | NOT RUN | Native memory stayed off; browser search does not qualify this path. |

## Product failures and causes

Cleanup uses the wrong database connection. `worker.ts` registers
`memoryCleanupHandler` without its separate content database. The handler receives
`HandlerRuntime`'s jobs transaction and uses it for `verifySearchRemoval`.
The live jobs database has neither `projection_checkpoints` nor `memory_facts`;
the checkpoint query returns PostgreSQL `42P01`. Both tables exist in the content
database. The correction exhausted five retries. Later cleanup jobs on that stream
remain queued. [Saved job states](rerun/cleanup-jobs.json) and the database observations
record this. No job was replayed or altered to make cleanup pass.

The phone correction exposes the existing read-after-write gap. Its POST returned
200 at 07:21:20.396. The immediate detail GET returned 503 at 07:21:20.491;
the memory worker finished applying the correction at 07:21:20.498.
`memorySnapshot` refuses reads while the projection is behind. `MemoryEdit.refresh`
reads once and passes that unavailable result to the panel, which hides its actions.
The [timing extract](rerun/correction-timing.json) and
[failure picture](rerun/followup-failure-390.png) show this sequence.
The accepted correction remains recorded. No write retry or UI bypass was used.

## Setup and collector failures

The [first setup attempt](setup-attempt/observations.jsonl) stopped after successful
SSO because the claim screen could not check sign-in. The server had no subsequent
session-read request. Its precise cause remains unknown. A diagnostic sign-in passed;
that does not turn the failed attempt into a pass. A second fresh install followed.

The [next attempt](input-attempt/observations.jsonl) used a login name as an email.
Browser validation prevented submission. The collector now reads the test contact
email from the private slot file `memory-owner-email`. No claim had been sent;
the unused setup token was replaced before retrying on the still-empty installation.
The invitation collector initially supplied a non-UUID member id. The API refused it;
a valid UUID then allowed invitation and joining. These are collector setup failures.
The first rebuild probe used an unsupported event subject and stopped before replay.
The corrected probe used the event store's global position. No data was changed by it.

## Pictures and limits

All 33 saved pictures were inspected, including the original four, both setup attempts,
and the new 1280 and 390 captures. They contain no visible email or private path.
All ten MEM-30/33/34/40/41 design references were inspected.
The store and correction forms fit their captured widths. Receipt pictures taken
before the detail refresh still show revision 1 beside the accepted revision 2;
they are transitional pictures, not proof of the refreshed value. Later HTTP reads
establish the retained correction. The early phone list pictures show Searching;
the phone detail picture shows Loading. The isolation failure pictures are blank
collector pages and establish no product state. No keyboard or assistive-technology
qualification is claimed. Other memory scopes remain NOT RUN.

## Final local checks and release

PASS: clean `npm ci`; requested NATS and Lychee links; eight acceptance tests twice;
438 event security tests; CI dev-stack test selection; 153 catalogue event types;
`npm run lint:docs` including the public-evidence privacy check; `npm run lint:changelog`.
All lint, typecheck and test commands ran under `nice -n 10`.
PASS: full workspace typecheck, including package and dev-stack checks.
PASS: full `npm run lint`, including Knip, documentation, links, fixture and licence
checks. ESLint reported only existing function-length warnings and no errors.
The security suite used a disposable PostgreSQL 17.6 database with `PG_TEST_URL` set.
Its container and volume were removed with `docker rm -f -v`.
PASS: `down.sh --id 1` released the slot. Its owner marker and Compose containers
are absent. Only claimed resources were removed.
The full root suite is NOT RUN, as required by the build prompt.
