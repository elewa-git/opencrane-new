# Host preflight checks

Final source: `4e637fef0e1024dbbf42e411cb79b22cbe10e0be`.

## Own checks

| Check | Result |
| --- | --- |
| Full workspace, package and dev-stack typecheck | PASS; dev-stack checked again after the final changes |
| Event catalogue | PASS; 174 event types |
| Knip | PASS; two existing configuration hints |
| Changelog and README lint | PASS |
| Markdown lint | PASS |
| Changed-file ESLint | Repository configuration excludes infrastructure; scoped command completed with no warnings |
| Supplementary lint of the new production helpers | PASS; recommended rules and standard complexity, depth, parameter and size limits |
| Host and node fixtures | PASS twice; 33 tests per run |
| Source inventory regression | PASS twice; four repository helper hashes |
| Licence fixtures | PASS twice; 82 tests per run |
| Final installer file | PASS twice; 271 tests per run |
| Copied package journey fixtures | First run PASS: 86; second run 85/86, with the NATS deadline failure retained below |
| NATS route file in the quiet resource window | PASS: all 19 tests; unchanged process deadline |
| Public privacy and secret scans | PASS before each source push |

All local tests, lint and typecheck commands ran under `nice -n 10`. No full root
test suite ran. Website source is unchanged, so separate web tests and a local
web build are not applicable. The approved package workflow builds the website.

Saved output: [installer run one](logs/installer-1.log),
[installer run two](logs/installer-2.log), [host run one](logs/clean-host-1.log),
[host run two](logs/clean-host-2.log), [workspace typecheck](logs/typecheck-full.log),
[events](logs/ready-events.log), [Knip](logs/ready-knip.log),
[changelog](logs/ready-changelog.log), [README lint](logs/final-readmes.log),
[scoped ESLint](logs/ready-eslint.log) and [supplementary lint](logs/clean-eslint.log).

The repository's ESLint configuration excludes `infra/`. Forcing those files
through its workspace parser fails because they are outside its configured
projects. No repository ignore or limit was changed. A temporary configuration
applied the standard limits directly to `package-hosts.ts` and
`host-preflight.mjs`; both passed without warnings. Typecheck and the package
fixtures cover the integration with the existing infrastructure modules.

## Failures and corrections

- Failing-first commits `89dbe0e14` and `e71ef638a` pin host refusals and per-node
  orchestration. A no-op host decision passed two cases and failed the other 21
  before implementation. The finished host fixture set contains 24 cases.
- Removed F1 and F2 independently in isolated copies of the real module. Their
  refusal tests each failed with exit 1. The production rules stayed intact.
- Commit `99a318c14` reproduces a stale repository helper hash: three source
  records passed and `codex-config.ts` failed. Updated only that OpenCrane
  helper's hash. Third-party hashes and licence decisions are unchanged.
- Commit `1917ed8aa` reproduces acceptance of a copied local container name with
  another API node UID. The installer now compares UIDs with the local server.
- Commit `c9a7fac65` reproduces use of the historical image instead of the
  current approved install image. The installer now validates the install image
  first and reuses it for the read-only probes, before any Helm command. An
  initial registry HEAD request without OCI content negotiation returned 404;
  the corrected request returned 200 for every historical pin. Those images
  were not missing, and this is not evidence of an availability defect.
- The first fixture runs exposed a mock password equal to a mock image digest,
  a substring check that confused the registry name with the shared context,
  and the absence of a command log when ownership refused before any command.
  Kept the privacy and ownership assertions; used distinct fixture data and
  exact context arguments. A disappearing target is now refused by the earlier
  ownership check. No refusal became an acceptance.
- Two intermediate broad runs passed 379 and 380 tests while the change was
  still being built. The final installer runs are recorded separately above.
- The supplemental NATS file exceeded its existing 30-second child-process
  deadline in a run that overlapped another live qualification. The load monitor
  recorded peaks above 10. That does not prove load was the only cause. The
  failed run is retained. A separate run started with both slots free and lower
  load, and passed all 19 cases; another task claimed a slot during its final
  cases. No timeout, retry or production NATS rule was changed. High-load timing
  is not qualified by that passing run.

Retained the [first copied-fixture run](logs/copied-fixtures-1.log),
[failed second run](logs/copied-fixtures-2.log) and
[separate NATS run](logs/routes-quiet.log). Failing-first evidence includes
[host decisions](logs/red.log), [node orchestration](logs/hosts-red.log),
[local identity](logs/local-identity-red.log),
[source inventory](logs/native-source-red.log),
[probe image](logs/probe-image-red.log), and independent removals of the
[F1 rule](logs/mutation-F1.log) and [F2 rule](logs/mutation-F2.log).

## Make it right

Share the F1/F2 decision and host reader between the local operator probe and
node checks. Keep node collection, local Docker verification and installer
ownership in their existing responsibilities. Name the volume, mount, mapping
and result values before using them. Split fixture argument checks, successful
install checks and rendered resource checks out of the old large fixture runner.
New helpers remain below the standard function and parameter limits. The touched
installer has 60 counted lines; the new helpers have at most 28 counted lines
and three parameters. No limit,
application dependency, event type or SQL rule was added or weakened.

Independent review is not run by the builder. The orchestrator owns it.

Shipped code: 301 added and deleted lines. Counting the two test-support files
conservatively as shipped code gives 312 lines. Tests, docs and receipts are excluded.
