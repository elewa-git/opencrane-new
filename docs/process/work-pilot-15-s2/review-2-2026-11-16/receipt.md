# Final-head packaged backup qualification

Date: 16 November 2026. These are the builder's own checks.
Pushed head: `91e7ab60346c5ae346260acd3411b79bdd5eddc6`.
Rebase onto `e5463218c` (#1137): **PASS**, finished without conflicts.
The source stays fixed while its approved images are qualified. Generated live
evidence remains in the worktree; the PR also records the final receipt.

## Image approvals and CI

- Application [43911114619](https://github.com/elewa-git/opencrane-new/actions/runs/43911114619): **PASS** for this exact head.
- Scanner [43911114776](https://github.com/elewa-git/opencrane-new/actions/runs/43911114776): **PASS** for this exact head.
- Final CI [43911128733](https://github.com/elewa-git/opencrane-new/actions/runs/43911128733): **PASS**, including all four test shards, both fixture jobs, checks and ci-ok.

Both approval jobs used the existing standard runners and authenticated artifact
transport. No local approval or preflight exception was introduced.

## Findings and test strength

The test-first commits are `728fe2d1d` and `5505f33d5` after rebase.
Shared rules and configuration cleanup are in `38065b07a`.

1. **PASS:** each application role is replaced independently in values and review.
   Missing/malformed configuration IDs, an unapproved snapshot URL, three distinct
   index paths and forbidden bundled/manual inventory licences refuse. The licence
   cases use the complete writer with an otherwise matching scan. The integrated
   index case authenticates three different payloads and refuses damage in each.
2. **PASS:** refuse fork dispatch, local invocation, fork producer and mismatched
   checkout before Docker or publication output.
3. **PASS:** both Python checkers use the checksum rule in check-licences.py. Both
   approval fixtures share checkout identity and the Git shim beside the scanner
   fixture. The inline predicate has a name.
4. **PASS:** remove the unused approval setting and document the fixed repository,
   workflow and event policy.

Repeated all ten deliberate guard-removal probes on this rebased checkout. Each
focused test failed for the expected reason; restored every guard. The server and
web comparisons were removed separately. Removing configuration-ID validation,
snapshot URL validation, the all-index loop or complete inventory checks failed
their own tests. Removing the workflow repository restriction or each of the three
shell producer checks also failed before Docker/output assertions could pass.
The normal 27 application and five Python test methods passed after restoration.

Expanded route caller checks exposed missing transport/application approval in their
fixture. Reused the existing approval fixtures. Process tracing then found 240 mock
Docker starts consuming 22.56 seconds in Node startup in the positive case. The
equivalent Python standard-library fixture preserves every ownership response,
check, assertion and deadline. Both complete route runs pass after this cause was
fixed. Earlier failed runs remain part of the attempt history.

## Own gates on the rebased head

| Check | Verdict | Evidence |
| --- | --- | --- |
| Application/preflight twice | PASS | 71 per run. |
| Scanner twice | PASS | 30 per run. |
| Python approval/index twice | PASS | Five test methods with multiple refusal cases. |
| Licence suite twice | PASS | 82 per run, including the earlier candidate checker. |
| Route callers twice | PASS | 19 per run. |
| Installer acceptance/refusal | PASS | Both real-preflight rendering cases. |
| Chart callers | PASS | 28 cases. |
| Typecheck | PASS | All workspaces, package and dev stack. |
| Event catalogue | PASS | 174 types agree. |
| Knip | PASS | Two existing configuration hints. |
| Changed-file ESLint | PASS | Repository scope plus explicit checks of changed infrastructure; no warnings. |
| Changelog and Markdown | PASS | Branch note; Markdown without file arguments. |
| Read ledger | PASS | 311 known reads; main's repair is included. |
| README allowances | PASS | Existing limits retained. |
| Privacy and secret scans | PASS | Before every source push. |

All tests, lint and typecheck ran under `nice -n 10`. No full local root suite ran.
No dependency was added. Kept every access, money and memory check, assertion,
timeout and size limit.

## Fresh stack and packaged journey

Fresh secondary `up.sh --fresh` on this head: **PASS**, including the automatic
journey and its budget checks. Website readiness took 56.849 seconds. Both
package-down and down.sh returned zero. The owner stack was not touched.

Final-head PACKAGED journey: **PASS**. Both approvals were fetched through the
normal authenticated github.com path, and both revisions match the pushed head.
The [installation record](installation.json) binds the exact source, both run ids,
configuration digest, scan checksum and installed image:
`k3d-ocn-registry:5000/opencrane/package@sha256:91b5ce8f1adb2cd864a50190d993436d348e720074f3b173201ec37b31b22afc`.

| Observation | Verdict | Evidence |
| --- | --- | --- |
| Fresh claim, preparation and installation | PASS | New owned namespace and storage; exact-source approvals and image bindings. |
| Person uploads and chats at 1280/390 | PASS | Real SSO, HTTP 201, Ready attachment and an answer reading Willow-47 from the PDF. |
| Malware refusal at both widths | PASS | HTTP 422 and visible refusal; the rejected file is not saved. |
| Trigger installed CronJob and see completion | PASS | Manual Job completed in 71 seconds at sequence 92. |
| List backup and read manifest | PASS | Exactly one checked set; show validates its saved bytes. |
| Native content checks | PASS | Event archive, all database dumps without role passwords, uploaded PDF bytes and one shared sequence. |
| Broken file part fails visibly | PASS | Separate Job from the installed CronJob changes only the object-owner mount; Failed with reason parts. |
| No publication and recovered server | PASS | Checked catalogue unchanged; server rollout completed. |
| Evidence saved while installation existed | PASS | Six screenshots, outcomes, installation binding, manifest, catalogues and operator output. Inspected both answer pictures before teardown. |
| Package-down and down.sh | PASS | Both returned zero; namespace and slot released. |

Backup `bcfca17d-597f-4ee4-a10f-7dcc80d2cebe` has event/database/file parts of
18,424, 335,670
and 2,165 bytes. The manifest records the image
and chart versions, all read-table positions, hashes and file inventory. Native
archive, SQL and file bytes stayed private and were removed with the secondary volume.

Evidence: [operator output](operator-output.txt), [installation](installation.json),
[manifest](manifest.json), [catalogue](catalogue.json),
[catalogue after failure](catalogue-after-failure.json), [browser outcomes](outcomes.json),
[1280 px answer](file-answer-1280.png), [390 px answer](file-answer-390.png),
[1280 px clean file](clean-ready-1280.png), [390 px clean file](clean-ready-390.png),
[1280 px malware refusal](eicar-refused-1280.png) and
[390 px malware refusal](eicar-refused-390.png).
No earlier namespace or screenshot qualifies this source.

## Earlier attempts retained

- **FAIL:** supplementary Compose on `a9a65eeb7` timed out waiting for the assistant
  budget-ceiling refusal at 390 px. Its cause remains unknown. Kept the money check
  unchanged. Both teardown commands returned zero.
- **FAIL:** first packaged preparation on `dbb4a949a` returned its fixed refusal before
  installation. Its underlying cause was not exposed and remains unknown. Both
  teardown commands returned zero.
- **PASS, diagnostic only:** a separate fresh claim completed preparation in 53.7
  seconds under the unchanged 120-second boundary. It did not qualify a journey;
  both teardown commands returned zero.
- **PASS, earlier head only:** the later `dbb4a949a` packaged run passed both browser
  widths, backup/list/show/native contents and visible failed file capture without
  publication. Both teardown commands returned zero. Its evidence was archived
  before rebase and does not qualify the current head.

Restore, computer homes, three event-log copies, off-machine durability and managed
cluster qualification remain outside this slice. The PR remains a draft.
