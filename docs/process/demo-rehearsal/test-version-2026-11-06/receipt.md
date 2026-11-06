# Current main rehearsal, 6 November 2026

**PARTIAL: the latest fresh secondary start passed the built-in journey, demo seed,
both smoke widths and the member memory check.** The ten-step script stopped on a
browser read in each of three attempts. No new source qualifies the owner refresh.
The earlier failed starts remain recorded below.

## Source and setup

The pinned starting `origin/main` was
`2e860bac3b6099790e40ef38bb917408b1d6573a`. The worktree was
`<worktree>` on `work/test-version-rehearsal`.
`git fetch origin main` and the fast-forward check passed; the branch was already at
that commit. `npm ci` passed. The worktree's ignored `.tools/nats-server` and
`.tools/lychee` were linked to the main checkout's tools.

`infra/dev-stack/claim.sh` returned secondary slot 1. The attempt used
`DEV_STACK_ID=1`, `DEMO_ALLOWANCE_CENTS=1000`, and the requested credential **paths**.
The operator did not read or print either credential file. Screenshot masking was
loaded before startup. No owner-stack command was run; its port 44200 remained listed.

The fresh `demo-up.sh` printed:

```text
PASS dev-only owner bootstrap: jente-rosseel owner; OpenFGA owner=true
Provider setup default: timeout
```

The command exited 1. It reached provider setup but did not complete the fresh
startup or seed. In `infra/dev-stack/provider-setup.ts`, the `seededDefault()` wait
starts after model selection and allows 30 seconds for a `silo_default` binding.
This is the point that timed out. The product or its startup path failed before the
browser journey; there is no picture that could justify the permitted script-only
retry. No retry was made.

## Stage A results for the first start

The times and pictures for unrun checks do not exist. The Stage A script did not
begin, so an earlier rehearsal cannot fill these rows.

| Step | 1280px | 390px | Picture and time |
| --- | --- | --- | --- |
| 1. Streamed reply and reload | NOT RUN | NOT RUN | None |
| 2. Scanned quote, total/date, preview/download | NOT RUN | NOT RUN | None |
| 3. Action history | NOT RUN | NOT RUN | None |
| 4. Stop and partial reply after reload | NOT RUN | NOT RUN | None |
| 5. Live member-to-owner message at 390px | NOT RUN | NOT RUN | None |
| 6. Private shared-assistant reply | NOT RUN | NOT RUN | None |
| 7. Group chat and unopened invite link | NOT RUN | NOT RUN | None |
| 8. Model answer with its key hidden | NOT RUN | NOT RUN | None |
| 9. Company ceiling refusal and restore | NOT RUN | NOT RUN | None |
| 10. Limit and group change history | NOT RUN | NOT RUN | None |
| Extra: personal memory off and invisible to a member | NOT RUN | NOT RUN | None |

The member memory check could not run on the same slot because startup failed.
Source inspection found a `Memory` tab in `apps/web/src/app/chat/workspace.html`;
the live member result is unproved. The smoke command also did not run.

## Spending and cleanup

The startup may have made a paid provider verification call before the timeout.
The launcher removed slot 1's private records during its failure cleanup, before a
spending receipt could be copied. Charged and held cents are therefore **unknown**.
The 1,000-cent task cap was supplied to startup, and no further paid call was made.
No claim is made that the task spent zero cents or stayed below a measured total.

After the failed launcher exited, a subsequent `claim.sh` returned slot 1 again.
`infra/dev-stack/down.sh --id 1` released that claim. The slot directory was absent
afterwards. The owner stack, its port, its processes, containers and data were not
changed. There are no pictures to publish or redact.

## Second fresh start and diagnosis

The provider wait fix was committed separately as
`00e8ae22f49a972ef9f13413d38cf08c01a709e3`, on top of the starting
`origin/main`. This full SHA was the branch head and the only source used for the
second live start. The fix gave the background worker 120 seconds for the first
binding, matching the fresh secondary service readiness limit. A test delayed the
binding beyond 30 seconds: it failed with the old limit and passed with the fix.
The provider setup test passed twice. Lint (including knip), typecheck,
`check:events`, `lint:changelog` and the event security test passed. The first
security-test command used the wrong runner; the correct Vitest run passed 460 tests.

The first slot was already absent. `down.sh --id 1` returned `free`, then
`claim.sh` returned slot 1. Fresh `demo-up.sh` used the two credential paths
without reading or printing either file. It had `DEMO_ALLOWANCE_CENTS=999`.
The launcher passed owner bootstrap, then stopped with
`Provider setup default: timeout` after the longer wait. Its failure cleanup
removed slot 1. No smoke or script command ran.

The second run's private dispatcher log was copied before cleanup. It records
`seed-provider-default` starting and completing for `provider.models_selected`
in 64 ms. It also completed twice for `provider.verification_recorded`.
There is no `provider.model_binding_set` entry in that log, and setup's
binding reads never found a `silo_default` choice during 120 seconds.
The automatic handler returned without recording the choice. This rules out
a worker that was merely still running after 30 seconds. The saved log has no
reason for the handler's early return. Database rows could not be inspected:
the launcher removed the secondary data during its failure cleanup. The logs
remain private under `/tmp/test-version-rehearsal-failure/`; no raw log is in
this public receipt.

The source change does not fix this missing-binding defect. The first run's
possible provider verification hold remains unknown. The quoted bound for
that one call is 1 cent, and the same bound applies to the second start.
Count **2 held cents conservatively** across the two attempts; actual charges
and settlement are **unknown** because both launchers removed their data.
No further paid call was made. The owner stack and port 44200 were untouched.

All Stage A rows above remain **NOT RUN** at both widths; there are no new
pictures or timings for them. The previous owner-refresh SHA in the guide
remains the last qualified source. The new pinned SHA is **not qualified**.
The orchestrator owns the product fix and a further fresh qualification.

## Startup repair and further fresh starts

The source for the first new attempt was `fc9d87e8b2a3d19266ad23b5f43c03cef6e5cf04`.
A regression test showed that the default handler could finish when its history read
missed the model selection event. The handler now fails that read so dispatch can retry.
The test failed on the earlier source and passed after the fix. The provider binding
guard suite passed twice, with 39 tests each time.

That fresh attempt still stopped at `Provider setup default: timeout`. A read-only
check before cleanup found a `provider.model_binding_set` for `silo_default` at event
position 46. Every provider binding GET in the server log returned 503. This corrects
the earlier inference that the dispatcher had never written a binding: the old log
did not include binding events, so it could not prove their absence. No key or private
event data was copied into this receipt.

The cause was the secondary start list: it did not run the routines read worker.
Provider binding GET now checks that worker's progress before returning a choice.
The missing worker kept every GET at 503 even though the choice was saved. A startup
test failed with the old list and passed after adding `routines`. The full startup
test file passed twice, 45 tests each time. The repaired source was
`9fe3cae7d988f6c8ca590efa0ffd49be004239b9`.

At that source, the next fresh start passed owner bootstrap, provider setup and
website readiness. Its built-in journey stopped before running because the fleet
task marker was set. The private failure record said automated journeys require a
secondary stack and no fleet task. The launcher cleaned slot 1.

The owner had explicitly authorised this secondary rehearsal. The next fresh start
used the same source with that marker omitted for the launcher process. It passed
owner bootstrap, provider setup and website readiness. The built-in real-model
journey then failed at **scanned supplier PDF total and delivery date**. The private
error named that check. Its saved outcome file records PASS for the owner streamed
reply and reload, Stop and reload, and a later member reply through the default.
The PDF check is FAIL. The launcher cleaned slot 1 before seeding. Its separate
smoke, Stage A script and member memory check did not run. The journey guard code
and the owner stack were not changed.

| Check on repaired source | Result |
| --- | --- |
| Fresh provider setup and saved default choice | PASS |
| Built-in journey: first three checks | PASS |
| Built-in journey: scanned supplier PDF | FAIL |
| Demo seed | NOT RUN |
| Separate smoke at 1280px and 390px | NOT RUN |
| Ten Stage A steps at both widths | NOT RUN |
| Member memory-off row | NOT RUN |
| Owner refresh | NOT RUN |

No new Stage A picture or timing exists. The earlier Stage A table remains accurate
for this run too. The built-in journey's saved receipt records four reservations:
49 reserved cents in total, 7 charged cents known and one unresolved 16-cent hold.
That receipt was kept privately outside the removed slot. Other startup calls and
the earlier fresh starts have unknown final charges and holds, so the total for
these attempts is **unknown**.
The last three attempts supplied allowance values of 990, 989 and 988 cents; the
authorised journey attempt supplied 987 cents. These values are limits supplied to
the runs, not measured charges. No further paid check was started after the PDF
failure. Slot 1 was removed by launcher cleanup after every failed start. The owner
stack and its processes, ports and data were untouched.

## Fifth fresh start: PDF upload diagnosis

At source `2b01fb6fd16118eaa0c9eb854ddfdca3a7926322`, a new claim of
secondary slot 1 started fresh with a 500-cent stack ceiling. Startup was called
directly so failure would leave the slot's read-only records available. Provider
setup and website readiness passed. The built-in journey again recorded PASS for
the owner reply and reload, Stop and reload, and the later member reply. The PDF
check failed. No seed, smoke, Stage A step or member memory check ran. The earlier
attempts above remain failures.

The browser sent one `POST /api/conversations/.../files` at 09:53:34 UTC. The
server returned 503 in 747 ms. The files read table contained no `supplier.pdf`
row. There was no `file.uploaded` or `file.delivered` record for that draft.
The Compose ClamAV daemon was healthy, but the server had no `SCANNER_URL` or
`SCANNER_CA_FILE`. `scanFile()` rejects missing settings before it contacts the
scanner. The browser waited for Ready and timed out. The saved private error only
named the overall PDF check because the journey catches the browser error.
The built-in PDF fixture contains selectable text, so this check does not need OCR.

| Part of the PDF check | Observation |
| --- | --- |
| Browser upload | One request; 503 in 747 ms |
| Malware scan | NOT RUN: no authenticated scanner was configured |
| PDF conversion and OCR | NOT RUN: no file reached the computer |
| Assistant file read | NOT RUN: no PDF turn was sent |
| Model answer | NOT RUN: no PDF turn or model call occurred |

This is a startup defect. The 26 October source `f11df5c56` used the earlier
direct ClamAV path. Since then, `548e8c8ad` replaced that path with authenticated
HTTPS scanning. `8c2760fc1` widened Office inspection; `3391faf4f` changed
upload refusal reasons; `ccd0d5eb2` added desktop drag uploads; and `5dbd530c2`
changed image upload and file presentation. `c3e7ae2e2` and `9e470b61e` changed
backup and restore checks for file storage. Changes to chat delivery and turn
handling were `f68811c94`, `955cfedca`, `12ca064d7`, `54cb4ff75`,
`276a9ba2d`, `4a0fac39c`, `a7d9154d6`, `efd681e5c`, `49a796748`,
`e40c6614d`, `bb20e43ec`, `5e5882fed`, `6031183eb` and `67e1cff99`.
The PDF conversion in `receive-file.py`, attachment read in `turn-input.ts`,
and built-in PDF check itself did not change. This list comes from the
path-limited git log; only the scanner change explains the observed 503.

The saved journey outcome counted 49 reserved cents: 7 charged and one unresolved
16-cent hold. Earlier attempts include unknown final costs, so no combined
spending total is claimed. No further paid call was made after this failure.
Private copies of the outcome, error and server request log were kept outside
the removed slot under `/tmp/test-version-private-attempt5/`. No screenshot was
published. `down.sh --id 1` released the slot after those copies. The owner
stack was not touched.

The failing-first startup test was committed as `7d4d32371`. It proved that
the fresh server did not receive scanner settings. The follow-up code passes an
explicit HTTPS endpoint and CA file to the server and refuses startup when
either is missing. No reviewed scanner release or trust settings were configured,
so the repaired startup and full paid sequence are **NOT RUN**. The owner
refresh SHA remains the earlier qualified source.

## Sixth fresh start: authenticated scanner and demo checks

The source was `c21904a4b03e2c8724a941b39a60a3a2181c7a76` on
`work/test-version-rehearsal`, after fetching and rebasing on `origin/main`.
`claim.sh` returned slot 1. The fresh start used the existing credential file
paths and a 400-cent stack ceiling. No credential value was read or printed.
The stack started its own ClamAV daemon and authenticated HTTPS scanner on its
loopback port. The CA, server certificate and their private keys, plus the model
worker's CA copy, all had mode 0600 in the slot directory. The server received
the scanner settings, and startup waited for the scanner before the browser journey.

The built-in journey passed its owner reply and reload, Stop and reload, later
member reply, and scanned supplier PDF total and delivery date. The PDF check had
failed before the scanner service was started. Its saved receipt records 10 charged
cents and one unresolved 16-cent reservation. The demo seed passed. The
separate smoke passed: warm-up took 32,092 ms, the 1280px run took 85,422 ms,
and the 390px run took 81,045 ms. Its final receipt records 16 charged cents,
35 held cents and ten calls. It removed its saved ceiling file after restoring
the previous company limits.

The first ten-step script attempt stopped at desktop step 5. Its member picture
shows the first direct message, but the owner's page said direct conversations
were unavailable. The owner did not see the message within 120 seconds. A new
signed-in browser then received HTTP 200 and valid conversation lists for both
people. This read did not change the failed result. A script-only retry passed
desktop steps 1–6, then stopped at step 7 when the Acacia Trading group details
page said groups were unavailable. The group-chat message itself passed. A new
signed-in browser loaded that page and its API returned HTTP 200. A third script
attempt again passed steps 1–6 and failed at the same group details heading.
No fourth paid attempt was made. Each attempt has its own saved results and
masked pictures; later attempts do not replace the earlier failures.

| Step | 1280px, third attempt | 390px, third attempt |
| --- | --- | --- |
| 1. Streamed reply and reload | PASS | NOT RUN |
| 2. Scanned quote, total/date, preview/download | PASS | NOT RUN |
| 3. Action history | PASS | NOT RUN |
| 4. Stop and partial reply after reload | PASS | NOT RUN |
| 5. Live member-to-owner message at 390px | PASS | NOT RUN |
| 6. Private shared-assistant reply | PASS | NOT RUN |
| 7. Group chat and unopened invite link | FAIL: group chat passed; group details did not load | NOT RUN |
| 8. Model answer with its key hidden | NOT RUN | NOT RUN |
| 9. Company ceiling refusal and restore | NOT RUN | NOT RUN |
| 10. Limit and group change history | NOT RUN | NOT RUN |

The extra member memory row passed at both widths. The owner's live chat
context reported memory admission `disabled`. The member's scope list excluded
the owner's personal scope, and a direct read of it returned 404. The member's
Memory panel loaded at 1280px and 390px. Both private pictures masked email
addresses and credential fields. This checks access and the visible panel; it
does not enable private memory loading for model turns.

The last stack budget read showed 50 charged cents and 102 held cents, counting
unresolved reservations in full. This fresh run therefore used 152 cents of the
500-cent task allowance. Earlier attempts in this receipt have uncertain final
costs, so no exact combined total is claimed. No further paid step was started
after the third script failure. Private JSON receipts and 34 masked script
pictures were copied to `/tmp/test-version-attempt6/receipts/`; the unmasked
smoke pictures were not copied or published. `down.sh --id 1` removed the slot
directory and scanner container, and `status.sh --id 1` reported `free`.
The owner stack was untouched. This source is **PARTIAL** and does not qualify
the owner refresh.

After the live run, the override route for image workers was corrected. The
final branch head therefore differs from the live source above and has **NOT RUN**
the fresh journey. On the final tree, lint, typecheck, the event catalogue,
unused-code and changelog checks passed. The CI test grouping check passed.
Changed startup and scanner tests passed twice, 57 tests each time. The event
security suite passed once, 460 tests. The first test run after the override
edit failed before startup assertions because its loader fixture missed the
new export; the fixture was repaired before the two passing runs.
