# Personal memory qualification

25 October 2026. Part of #94. Part of #95. Both remain PARTIAL.

The fresh journey **FAILS at Forget after correction**. The server correctly refuses
an old revision, but the browser lets the person submit that old revision while
correction details are refreshing. No memory write was retried or bypassed.

## Source and installation

PASS: `git fetch origin` and rebase finished on `88a436e44`, including #688
`f01ee18f7` and the cleanup and read-after-write fixes in #697 `88a436e44`.
The rebased journey source was `3359f7eb2`; only its output directory changed before
execution. After the journey, rebase also finished on `2e110978a` to include the
new public screenshot privacy fix. That later change did not alter memory code. Earlier prerequisites are #646 `59a81b70f` and #641 `105071aaa`.

One secondary slot, number 1, was claimed through `infra/dev-stack/claim.sh` and
started with `--fresh` and `DEV_OWNER_BOOTSTRAP=0`. It had no members before the
browser claimed ownership. The run used real SSO and only the local model stub.
`ZITADEL_KEY_FILE` held a credential file path. The test contact and browser
sessions stayed in private slot files. Key folders belonged to the slot; no private
memory custody files were inspected. The owner stack was not used.

The tracked launcher was run with `DEV_STACK_ID=1` and `MEMORY_CLAIMED_ID=1`.
Temporary collectors then checked the saved correction, member isolation, restart
and offline rebuild. They used product HTTP routes and never appended events directly.
Product, Stage B, authority tests, event contracts and the acceptance checker are unchanged.

## Results from this installation

[Original observations](fixed-rerun/observations.jsonl) contain the saved replies.
The [request timing](fixed-rerun/request-timing.json) keeps only memory request
paths, methods, times, identifiers and HTTP status codes from the server log.

| Step | Result | Observed outcome |
| --- | --- | --- |
| Empty install, SSO and owner claim | PASS | No members before claim; browser confirmed ownership. |
| First Memory load | PASS | First scopes request returned 200; desktop list was empty. |
| Save a personal fact | PASS | Browser showed Saved; original receipt has revision 1. |
| Search and open | PASS | The synthetic garden fact opened with Edit and Forget. |
| Correct the fact | PASS | Revision 2 was accepted; later list and detail contain only the corrected value. |
| Immediate detail refresh | PASS | Product retried two 503 reads and received 200 without another correction POST. |
| Correction cleanup | PASS | Original status says completed, with its completion time. |
| Forget after correction | FAIL | Forget opened while revision 1 was displayed; its POST returned 409. |
| Original save and correction receipts | PASS | GET retained their original change ids, revisions and times. |
| Original forget receipt and forget cleanup | NOT RUN | Forget was refused; no accepted forget exists. |
| Lost accepted reply and GET-only recovery | NOT RUN | The main write journey stopped at the refusal. |
| Phone save, correction and forgetting | NOT RUN | No further memory writes followed the failure. |
| Another joined member's HTTP access | PASS | Owner list and corrected fact each returned 404 without text. |
| Another member's Memory screen | PASS | Search showed no matching fact at 1280 and 390. |
| Correction after reload | PASS | New browser reads and both widths showed revision 2. |
| Correction after retained server restart | PASS | Original receipts and revision 2 remained readable at both widths. |
| Offline memory rebuild | PASS | Server, dispatcher and memory worker stopped; event position stayed 47; model requests stayed zero. |
| Correction after rebuild | PASS | Original receipts and revision 2 remained readable at both widths. |
| Forgotten fact absent after reload, restart and rebuild | NOT RUN | This installation never accepted a forget. |
| Complete live acceptance checker | NOT RUN | Required forget and recovery evidence is absent; no passing input was manufactured. |
| Governed MCP recall and native memory | NOT RUN | Native memory stayed off; browser search does not qualify this path. |

## Root cause of the new failure

The correction POST returned 200 at 11:12:47.461 UTC. Its first detail reads
returned 503 at 11:12:47.569 and 11:12:47.959. The product's next detail read
returned 200 at 11:12:48.418. This confirms that the new retry handled projection lag.

Meanwhile, the person could open Forget. The
[correction picture](fixed-rerun/corrected-1280.png) shows the accepted revision 2
receipt, revision 1 detail, Saving, disabled Edit and enabled Forget. The
[forget review](fixed-rerun/forget-form-1280.png) opens over that same old detail.
The forget POST began at 11:12:48.174 and returned 409 at 11:12:48.385, before the
successful detail refresh.

`MemoryEdit` keeps `refreshing` and `awaitingRevision` inside the editor and disables
only Edit. The separate Forget button in `memory-panel.html` has no corresponding
disabled condition. `MemoryPanel.openForget` copies `selectedFact().revision` into
an immutable target. `MemoryForget.confirm` submits that target as `expectedRevision`.
The pictures, request order and this code identify the stale revision as the cause.
The POST body was not saved, so its exact input is inferred from that code and display.
The server's conflict check correctly protects the saved revision. A fix needs to
prevent Forget from taking the old detail while an accepted correction is refreshing.

The collector had not finished reading the 409 response body when terminated. It saves a write
observation only after reading the body, so it did not retain the forget command id
or body. It was terminated after more than two minutes. The safe server timing and
pre-submit pictures preserve the failure; no final conflict-screen capture is claimed.
This collector limitation is separate from the product's enabled stale action.

## Pictures and privacy

All 16 new pictures were inspected by eye, along with all ten MEM-30/33/34/40/41
references. They show no email address, home directory or private path. The initial
390 picture still says Searching memory and does not prove an empty phone list.
The correction and forget-review pictures intentionally retain the old displayed
revision as failure evidence. Later pictures establish the saved revision, not a
successful forget. The desktop edit sheet is centred; phone detail actions fit.
No keyboard or assistive-technology qualification is claimed.

## Earlier attempts

Earlier evidence remains unchanged. The [first observations](observations.jsonl)
record a first-load 503 before #688; later steps were NOT RUN. The
[setup attempt](setup-attempt/observations.jsonl) failed its sign-in check, and the
[input attempt](input-attempt/observations.jsonl) used an invalid contact email.
Those setup failures were separate from product qualification.

The [earlier rerun](rerun/observations.jsonl) passed desktop operations, GET-only
recovery, HTTP isolation and forgotten-fact absence after reload, restart and rebuild.
Its [acceptance input](rerun/acceptance.json) failed because cleanup queried the jobs
database instead of the content database. Phone correction also hit the one-read
projection delay. Those two causes were fixed in #697. That earlier result does not
qualify forgetting on the present source. Its 33 captures retain their original
limitations, including unfinished phone screens and blank isolation failure pages.

## Local checks and release

PASS: clean `npm ci`, the existing NATS and Lychee links, eight acceptance tests twice,
and the event catalogue check. The first claim command ran before installation had
finished and could not import a package; it claimed nothing. Claim and startup
succeeded after installation completed.

The launcher used after replay printed readiness and then exited with status 143.
Its cause was not established. A separate status check found all advertised services
healthy, and the browser readback passed at both widths. This does not qualify the
launcher exit as a pass.

PASS: 438 event security tests using a disposable PostgreSQL 17.6 database with
`PG_TEST_URL` set; the CI dev-stack test-selection check; `npm run lint:docs`, including
both public-evidence privacy checks; and `npm run lint:changelog`.
The database container and its volume were removed with `docker rm -f -v`.

PASS: `down.sh --id 1` released the slot. Its owner marker and Compose containers
are absent. Only claimed resources were removed. All lint, typecheck and test commands
ran under `nice -n 10`. The full root suite is NOT RUN, as required by the build prompt.

PASS: full workspace typecheck, including package and dev-stack checks.
PASS: full `npm run lint`, including Knip, documentation/privacy, links, fixtures,
licences and changelog checks. ESLint reported 25 function-length warnings and no errors.
