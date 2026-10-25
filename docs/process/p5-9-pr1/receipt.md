# Recovery after an interrupted handler upgrade

Date: 25 October 2026. Base: `f85834091`; event export #706 and restore #711
are on that base. This is a local fixture proof for part of #15.

The fixture exports 260 acknowledged events before changing handler subscriptions.
It kills the upgrade process after its first 256-event chunk commits. The saved
previous and target manifests remain available with the parked jobs. A different
manifest refuses without changing those jobs or the saved progress.

Recovery uses the earlier export, a reachable unchanged source and a separate empty
standalone NATS server. A disposable PostgreSQL database rebuilds the members
projection. The comparison covers ordered event ids, complete event hashes, global
and per-subject positions, all six membership tables and their checkpoint.
No reaction worker, dispatcher or scheduler starts. Callback guards in both
processes point to a tested recording endpoint. It must receive zero recovery calls.

A truncated archive refuses before transfer. A lost completion reply stays
uncertain even though NATS saved all 260 events. That target gets no projection,
second restore attempt, stream purge or deletion. Fixture teardown removes only
its owned processes and test data after the assertions.

## Checks

The [attempt record](attempts.txt) preserves the initial failures. The first commit,
`5284b01c4`, contains the tests before implementation. The checker was then run
with an empty implementation: its valid case passed and all 11 rejection cases
failed. The finished checker also compares full-event hashes.

- PASS: `npm ci` and the supplied local NATS/lychee tool links.
- PASS: 15 new cases at least twice; 42 existing handler-upgrade cases.
- PASS: all 438 event security cases once; `check:events` agrees on 154 types.
- PASS: full `typecheck` and `lint:unused` (knip).
- PASS: full `lint`, including documentation, licences and `lint:changelog`.

The [fixture summary](fixture-proof.json) retains the first completed proof's
manifests, positions, matching hashes, 258 parked jobs and uncertain restore result.
The throwaway PostgreSQL container and its volume were removed after testing.

The tests use a throwaway PostgreSQL 17.6 container and fresh TLS NATS processes.
All tests, lint and typechecks run under `nice -n 10`. No full root suite, live
stack, model call, installer or host-network change is part of this proof.
No dependency or event/API field was added. The exact `RISKY_FIELD_NAME` rule in
`security-rules.test.ts` was read; that file and the authority tests are unchanged.
The collected comparison fields contain ids, positions and digests only.

## Limits

Status: PARTIAL for this event-only recovery increment. Full P5-9: NOT RUN.
Handler manifests describe subscriptions. They do not establish package or schema
rollback compatibility. No package upgrade or Helm rollback is attempted.

Coordinated backups and restore of all databases/WAL, objects, computer volumes,
current custody and deletion state, rights/cents comparisons and a pinned-release
upgrade are NOT RUN. Serving and admission resume are NOT RUN. These tests do not
qualify a fresh packaged install or a customer recovery journey. The partial event
archive cannot authorise either one.
