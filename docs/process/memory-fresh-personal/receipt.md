# Personal memory qualification

25 October 2026. Part of #94. Part of #95. Both remain PARTIAL because governed
MCP recall and native memory are NOT RUN.

The fresh personal browser journey passes saving, finding, correcting and forgetting
at 1280 and 390 pixels. Another member cannot read the owner's facts. Both forgotten
facts stay absent after reload and server restart. A separate corrected fact remains
at revision 2 after a stopped-worker rebuild too. The complete acceptance checker
passes. No product failure occurred and no product workaround was used.

## Source and installation

PASS: `git fetch origin` and rebase completed on `7b0f48cc8`. Main is an ancestor
of this branch and no rebase remains in progress. This includes #688 `f01ee18f7`,
PR #697 `88a436e44`, #699 `e718e3e90` and the first-load permission fix #704
`7b0f48cc8`. The rebased journey source was `9ddb2b47e`; its output directory
changed before execution. Earlier prerequisites are #646 `59a81b70f` and
PR #641 `105071aaa`.

One secondary slot, number 1, was claimed through `infra/dev-stack/claim.sh` and
started with `--fresh` and `DEV_OWNER_BOOTSTRAP=0`. The collector found no members
before the browser claimed ownership through real SSO. The owner test user was
configured privately. `ZITADEL_KEY_FILE` contained only a credential file path.
The run used the local model stub, with native memory off and no paid calls.
Personal and memory key folders belonged to the slot. Their contents were not
inspected. The owner stack was not used.

The first claim command ran before `npm ci` had finished and could not import a
package. It claimed no slot. The claim succeeded after installation. The fresh
startup command later exited with signal status 143 while the web build continued.
A retained `up.sh` completed readiness and listener checks before the browser ran.
No member had been created, so this remained the same empty installation.
The phone collector also exited with 143 after saving its final reload observation
and picture. Later read-only checks independently confirmed its saved outcomes.
The signal sources were not established; neither interruption is a product pass.

The main collector command was:

```sh
DEV_STACK_ID=1 MEMORY_CLAIMED_ID=1 nice -n 10 node \
  --experimental-strip-types infra/dev-stack/memory-personal-live.ts
```

Temporary follow-up collectors reused the existing browser, sign-in and evidence
helpers for phone operations, isolation, restart, rebuild and final status reads.
They are not yet part of the tracked launcher. No business events were seeded
outside the normal stack setup, owner claim, invitation and memory commands.

## Results from this installation

The [observations](permissions-fixed-rerun/observations.jsonl) contain the original
write replies, command ids, status reads and persistence snapshots.
The [request timings](permissions-fixed-rerun/request-timing.json) contain only
fixed log fields and memory request paths. Earlier runs supply no missing results
for this installation. The [acceptance input](permissions-fixed-rerun/acceptance.json)
passed the unchanged `checkPersonalMemory` function.

The rebuild used `npm run replay -- memory --confirm-memory-stopped` under
`nice -n 10`, with the slot's projection settings. The collector verified process
identities and stopped the server, dispatcher and memory worker first. It compared
event and local model counts before restarting services and reading the rebuilt data.
No key files were inspected or replaced. Final status reads confirm cleanup for the
phone fact and retained correction as well as the original desktop commands.

Two final read-only capture attempts stopped because the text locator matched both
a list row and the open detail. Selecting the detail paragraph fixed the collector;
no product setting, response, permission or business state changed.

| Step | Result | Observed outcome |
| --- | --- | --- |
| Empty install, SSO and owner claim | PASS | No members before claim; browser confirmed ownership. |
| First Memory load | PASS | Scopes returned 200 and the empty personal list opened. |
| Permission delay on a later load | PASS | Two 503 replies were followed by 200 through the browser's own GET retries. |
| Save, find and open a personal fact | PASS | Desktop and phone each saved revision 1 and found the synthetic fact. |
| Correct the fact | PASS | Both accepted revision 2 and showed a correction receipt. |
| Forget immediately after correction | PASS | Both accepted revision 3 and hid the fact; no conflict or repeated POST. |
| Original receipts and cleanup | PASS | Status reads preserve command identity; correction completed and forgetting has a completion time. |
| Lose an accepted reply and recover | PASS | Phone showed Outcome unknown; Check status used GET only and recovered the saved receipt. |
| Another member's HTTP access | PASS | Owner list, live corrected fact and forgotten fact each returned 404 without text. |
| Another member's browser | PASS | Own personal list was empty at both widths. |
| Forgotten facts absent after reload | PASS | Both detail reads say forgotten; the list contains only the retained revision 2 fact. |
| Forgotten facts absent after server restart | PASS | Same HTTP results and empty garden search at both widths. |
| Stopped-worker memory rebuild | PASS | Event count stayed 58; model-request count stayed zero. Both forgotten facts remain absent. |
| Corrected fact retained after rebuild | PASS | HTTP and both browser widths show the Tuesday fact at revision 2. |
| Complete acceptance checker | PASS | Original receipts, cleanup, GET-only recovery and all three persistence snapshots satisfy the unchanged checker. |
| Governed MCP recall and native memory | NOT RUN | Browser search does not qualify these paths. |
| Other memory scopes | NOT RUN | This journey covers personal memory only. |
| Physical phone keyboard and assistive technology | NOT RUN | Chromium viewport captures do not qualify these conditions. |

## Pictures and privacy

All 36 new captures were inspected by eye before publication. The pictures contain only
synthetic facts and safe display names. No email address, home directory or private
path belongs in this evidence. The ten MEM-30/33/34/40/41 reference frames were
also inspected.

Representative pictures show the [desktop store form](permissions-fixed-rerun/store-form-1280.png),
[phone correction](permissions-fixed-rerun/phone-correction-form-390.png),
[desktop Forget review](permissions-fixed-rerun/forget-form-1280.png),
[phone Forget review](permissions-fixed-rerun/phone-forget-form-390.png),
[unknown outcome](permissions-fixed-rerun/outcome-unknown-390.png) and
[GET recovery](permissions-fixed-rerun/recovered-390.png).
Restart searches show absence at [1280](permissions-fixed-rerun/restart-absent-1280.png)
and [390](permissions-fixed-rerun/restart-absent-390.png).
The rebuilt correction is visible at [1280](permissions-fixed-rerun/rebuilt-correction-1280.png)
and [390](permissions-fixed-rerun/rebuilt-correction-390.png).

Three captures show loading rather than a settled result: `empty-memory-390`,
`after-reload-390` and `detail-390`. They do not prove an empty list or loaded detail.
Separate phone operations and settled reload captures supply that evidence.
The immediate correction pictures show the old detail while Saving remains visible,
alongside the accepted revision 2 receipt. Forget then uses the new revision.
These pictures do not claim that the detail had already refreshed.

The desktop editor uses a centred sheet rather than the reference side drawer.
The Forget consequences use plain bullets rather than the reference alert card.
Phone edit and Forget actions fit the viewport without the reference footer clipping.
This records functional behaviour and visual differences, not full design conformity.

## Earlier attempts

The [previous receipt](https://github.com/elewa-git/opencrane-new/blob/9ddb2b47ef0cb84e66bcdea6ce1c19bf4baa5c2e/docs/process/memory-fresh-personal/receipt.md) records the first-load failure
before #704. Its captures and diagnosis remain unchanged.
The [first observations](observations.jsonl), [earlier rerun](rerun/observations.jsonl)
and [fixed rerun](fixed-rerun/observations.jsonl) remain separate. Their earlier
cleanup, phone refresh and stale Forget failures were fixed on main before this run.

## Local checks and release

PASS: clean `npm ci`, existing NATS and Lychee links, ten acceptance and response
collector tests twice, and the CI test-selection guard. Tests, builds, lint and
typecheck run under `nice -n 10`.

PASS: 438 event security tests with `PG_TEST_URL` set to a disposable PostgreSQL
17.6 database. Its container and volume were removed with `docker rm -f -v`.
PASS: event catalogue, with all 154 event types matching.

PASS: full workspace typecheck, including package and development-stack checks.
PASS: documentation/privacy and changelog checks.
PASS: full lint, including Knip, dependency boundaries, documentation/privacy, links,
fixtures and licences. ESLint reported 25 existing function-length warnings and no errors.
The full root suite is NOT RUN, as required by the build prompt.
Product files, Stage B, authority tests, event contracts and the acceptance checker
are unchanged. No dependency was added.

PASS: `down.sh --id 1` released the slot. Its owner marker and Compose containers
are absent. Only claimed resources were removed. CI is not awaited after the push.
