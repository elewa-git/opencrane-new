# Budget recovery after interruption

Date: 26 October 2026. Base: `690c2e44c`. Source: `4b7af3b68`.
Test-first commit: `7755b2616`.
Part of #15. This receipt covers only event-to-budget projection proof.

The fixture saves three acknowledged reservations, a 70-cent settlement and an
unresolved effect before exporting 270 events. It interrupts the handler upgrade
after 256 events and refuses an incompatible manifest without changing parked jobs.
The earlier archive restores into empty disposable NATS. A separate PostgreSQL
database rebuilds all four existing budget tables twice using the production replay.
Original reservation and permit ids, 210 held cents, 70 settled cents and the
checkpoint must match. The unresolved 90-cent reservation stays held.

No BudgetActor, provider, scheduler, dispatcher or reaction worker starts on the
restored side. The recording endpoint is called once before its count is reset;
recovery must make zero calls. Replay appends no events, and each recovery sends
the archive to NATS only once.
A corrupt archive refuses before transfer. Lost completion leaves the populated
NATS target isolated, starts no budget replay and creates no projection tables.

## Checks

Environment: fresh TLS NATS processes and disposable databases in PostgreSQL
17.6, in the throwaway `pgtest-p5-9-pr2` container. The test connection uses its
random loopback port through `PG_TEST_URL`. All checks use `nice -n 10`.
No dev stack, model call, full root suite or host-network change is involved.

The first test attempt found eight missing row comparisons and a test reset problem:
an intentionally advanced checkpoint prevented the next test's replay. The reset
was corrected. The recorded red run then had one unchanged case pass and all ten
refusal cases fail against the empty comparator. The tests change database rows
before collection; they do not substitute hashes. The final cases also remove the
saved settlement amount separately from its effect record.

- PASS: `npm ci` and the supplied NATS/lychee tool links.
- PASS: 507 cases across recovery, budget comparison, handler upgrade and event security.
  This includes all 438 security cases and 42 existing handler-upgrade cases.
- PASS: the 14 changed cases again on the final code.
- PASS: full `typecheck`; `check:events` agrees on 154 event types.
- PASS: full `lint`, including knip, documentation, links, licences and `lint:changelog`.
  Code lint reported 25 function-size warnings in unchanged files and no errors.

The [check record](checks.txt) gives the commands and test results. The
[fixture summary](fixture-proof.json) retains matching budget hashes and checkpoints,
the interruption position and the uncertain restore result. The test container and
its volume were removed after both completed runs. Existing CI entries are unchanged;
the existing recovery glob includes the new budget test file.

## Limits

Status: PARTIAL. This proves event-to-budget projection recovery only.
CNPG/WAL, objects, volumes, rights, compatible packaged rollback, admission reopening
and full coordinated P5-7–9 remain NOT RUN. Current custody and deletion state,
pinned package upgrade and fresh packaged recovery also remain NOT RUN here.
No production accounting, custody helper, event/API name, dependency, authority
implementation or protected test changes. The exact `RISKY_FIELD_NAME` expression
was checked; comparison results contain only checkpoints and hashes.
