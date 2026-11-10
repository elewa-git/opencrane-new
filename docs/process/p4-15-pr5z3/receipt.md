# Held native persistence attempt: own receipt

Part of #97. Branch: `work/p4-15-pr5z3`.

## Observed outcome

**NOT RUN — the protected deployment target was absent.** The owned secondary
installation reached website and listener readiness. The persistence caller then
returned `NOT RUN`, `complete: false`, `category: inventory` before it could bind
the server and computer containers to the claim. There was no native launch, held
process read, private canary, forbidden tool call, live storage scan, Stop, or
after-Stop scan. No paid model call was made. The launcher released the secondary
slot after the refusal. The owner stack was not used.

The first startup could not read the local Zitadel setup token. After linking the
existing ignored token reference, startup reached readiness but its automatic chat
journey refused a fleet task. A failing-first launcher test covered the correction:
the launcher now selects the existing empty-installation mode. Its next startup
reached readiness and exposed the missing protected target as the first blocker for
the persistence caller. The target was not invented from a container name or a
hand-written receipt.

**NOT RUN:** proof of matching server and computer generations, a reviewed immutable
image, host protection, measured writable stores, the held native catalogue, all
eight forbidden tool classes, and both storage scans. A clean storage result and
memory admission cannot follow from this run. The separate fresh-install isolation
and memory qualifications remain outstanding on the chained work.

## Local checks

The launcher test failed before the correction because startup did not select the
empty-installation mode. After the correction, the three affected persistence
test files passed twice: 80 tests each time. The unchanged event security rules
passed once with 482 tests. All test runs used `nice -n 10`, one worker and a
disposable PostgreSQL test URL; the database and its volume were removed.

**PASS:** `npm ci`, changed-file ESLint, workspace typecheck, `check:events`
(173 event types), Knip, `lint:changelog`, Markdown lint, and the public
privacy check.

**NOT RUN:** the root suite and fleet qualification batch. They were outside this
part and did not run during the owned stack attempt.
