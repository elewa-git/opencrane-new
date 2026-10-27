# Encrypted computer home set

Part of #15. Overall status: PARTIAL. Live qualification: NOT RUN.

## Source and environment

27 October 2026. Branch `work/p5-7-pr3c` starts from `d35b7957f`.
Prerequisites are #706 (`d3f6acfda`), #733 (`9e470b61e`), #743 (`d0584938c`)
and #753 (`88e528d0d`). The accepted backup steps 1–3 and decisions D02/D06/D07
supply the design. This receipt records the builder's own checks only.

Implementation: `861d0b13f5a96bfa2d6e1f64c77c31bfb17f7886`.
Source checked after the fixture and readability edits: `b547ad355`.

The worktree has its own `npm ci` install and links to the requested NATS and Lychee
binaries. Tests use fresh disposable NATS processes, synthetic Kubernetes replies
and local byte streams. This is not a fresh product installation. No model calls,
dev stack, owner-stack changes, daemon changes or full root suite were used.
The selected suites need no PostgreSQL fixture; their commands use the supplied
`PG_TEST_URL` at port 55432. Lint, typecheck and tests run under `nice -n 10`.

## Behaviour checked

The exporter saves all inventoried homes inside one before/after observation interval.
All copies share 64 MiB and 60 seconds. Each encrypted file authenticates its home,
generation, safe file identity and complete event/archive inventory. One strict
version 2 descriptor appears only after all files and final inventory checks pass.
Lost and retired homes stay required. The result says `volume-export-only`.

Expected FAIL: the corrected two-home fixture refused on the original writer.
The first test commit is `b02391cd3`; later test commits correct fixture event ids,
assert every event append, cover failure cases and reproduce field-order sensitivity.
Expected FAIL: the unknown-format test found no descriptor validator.
Expected FAIL: reordered home fields broke independent decryption before the fix.

## Checks

PASS: 624 tests across `computer-volume-export`, `computer-volume-inventory`,
`event-backup` and the unchanged `libs/events/test/security-rules.test.ts`.
PASS: all 69 export tests again; four focused authentication/deadline checks also
pass after expanding assertions for readability. The commands use
`vitest run <files> --maxWorkers=1` with the settings above.
The [export cases](../../../libs/event-store/test/computer-volume-export.test.ts)
contain the independent decryption and failure probes.

PASS: `npm run check:events` (156 types agree) and `npm run lint:changelog`.
PASS: `npm run typecheck`, including every workspace, package and dev-stack checks.
PASS: `npm run lint`, including Knip, dependency checks, Markdown, local links,
README rules, fixture checks and package licences. ESLint reported zero errors and
27 existing length warnings. No dependencies were added.
The initial typecheck found three fixture dictionary accesses needing brackets;
those were corrected before the final run. No CI result is claimed here.

## Remaining work

NOT RUN: live mounted-volume capture and proof of which mount supplied the bytes,
live quiescence, CSI, crash durability, custody backup, database coordination and
fresh-install coordinated recovery. Local encrypted volume export is not a complete
backup and does not prove live PVC ownership. Admission and recovery are unchanged.
