# Current main rehearsal, 6 November 2026

**FAIL: the latest fresh secondary start passed provider setup, then stopped in the
built-in PDF journey.** Seeding, the separate smoke, the ten-step Stage A script and
the member memory check are **NOT RUN**. No new source qualifies the owner refresh.
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

## Stage A results

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
