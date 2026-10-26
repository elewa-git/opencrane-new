# Operator guide and index source receipt

Date: 26 October 2026. Part of #15. Base: `690c2e44c`.
Environment: existing worktree, Linux, Node 22.23.3. No fresh installation or image build.

PASS: `npm ci` installed the lockfile; NATS and Lychee use the requested local tool links.
It reported 20 vulnerabilities: four Low, nine Moderate and seven High, across all
dependency scopes. Shipped-path assessment and dated image scans are NOT RUN.
No scan clearance is claimed. The index keeps these unresolved blockers.
The offline lockfile update reported zero findings without a fresh audit. It does
not supersede the earlier result or clear the missing runtime/image scans.

PASS: test-first commit `ddde3405e` preceded implementation. Its first run failed
to import the absent checker; no tests ran. With an empty checker, 21 refusal cases
failed and both controls passed. The complete checker subsequently passed the initial
23 cases. The final source checks are below.

PASS: all 27 final checker cases twice; all 438 event security-rule cases once.
The whitespace-preservation test first failed, then passed after removing trimming.
PASS: full lint, all typechecks, event catalogue (154 types), Knip and changelog checks.
Knip first found the missing root development declaration; README checks first refused
phase numbers in link paths. Both were fixed. Targeted final ESLint also passed.
The existing root test glob lists the new test; CI and recovery test registration are unchanged.
Checks ran under `nice -n 10`; Vitest used one worker and the supplied `PG_TEST_URL`.

NOT RUN: full root suite, stacks, models, P5-13, full local P5-14 execution and hosted
acceptance. This source receipt does not qualify install, backup, restore or rollback.
The checker validates declared consistency and local links, not receipt authenticity.
The root tool declares the existing MIT Zod 4.6.6 as a development dependency.
No package version, runtime dependency, event/API name, authority code or protected test changed.
The exact `RISKY_FIELD_NAME` expression was read; no new event/API fields require it.
