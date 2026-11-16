# CI application approval and scheduled backup qualification

Date: 16 November 2026. This receipt records the builder's own checks.
Qualification source: `d5d7df6c4dbb92121f801dc909d3640c73122686`.
Packaged journey: **PASS**. Both teardown commands returned zero.

## Image approval

**PASS:** scanner [43874985247](https://github.com/elewa-git/opencrane-new/actions/runs/43874985247)
and application [43874985191](https://github.com/elewa-git/opencrane-new/actions/runs/43874985191)
approved this exact source before preparation. Both artifacts were fetched through
the normal github.com-pinned path. No local approval or preflight bypass was used.

The application job uses a standard Ubuntu runner, contents read permission and the
built-in artifact token. It needs no new secret, setting, paid runner or paid cache.
Forks cannot publish approval. It checks out the exact source, builds its labelled image,
inspects it, passes the 15 saved-layer/bootstrap checks, scans every layer and checks the
580-component reviewed inventory through the existing licence and promotion rules.
It authenticates all three Debian main indexes, including the reviewed keyring checksum,
release signatures, compressed-index checksums and signed sizes, and package versions.

The [installation record](installation.json) binds the exact source, both approval run ids,
application configuration digest and scan checksum. The installed application image is:
`k3d-ocn-registry:5000/opencrane/package@sha256:ae79458fc20b3b56da24692c72043926b4f762538f6f78abdcc9cdbb4ede6f22`.

## Findings and fixes

- **PASS: finding 2, owner option A.** Test commit `d697d7ece` reproduced matching
  builder-written application pins passing preflight without CI output. The consumer now
  accepts only successful exact-source GitHub output. Forged local pins, missing output,
  wrong source/run/workflow/branch, failed runs, forks and enterprise routing refuse.
- **PASS: application installation.** Test commit `89f6407c8` reproduced the real installer
  refusing a CI-approved application during rendered-image review. `d5d7df6c4` carries the
  already checked scanner/server/web pins into that review. Every other role keeps its
  fixed reviewed pin. Matching builder-written application pins still refuse before Helm.
- **PASS: scanner diagnostics.** Existing tests reproduced four logging-contract failures
  introduced by the shared transport. Restored the scanner logger name and release stage.
  Kept all credential-canary assertions. The application workflow runs these tests too.
- **PASS: findings 1, 3 and 4.** Retained the earlier readiness, real-adapter guard tests
  and shared digest repairs. Their own-check evidence is in the
  [earlier receipt](../review-1-fixes/receipt.md). No runtime backup code changed here.

The final clarity cleanup names release and fetch options before their calls. Its 15
application and 30 scanner tests passed again. It changes no application runtime behaviour.

No access, money or memory check was weakened. No assertion, timeout or size limit was
loosened. Sharing the chart path and reading the owner's context directly keeps the
existing installer file at its previous counted size. No dependency was added.
The addition contains **377 added and 128 removed shipped lines**; tests and documents
are excluded, and the moved historical checker is counted conservatively.

## Own gates

| Check | Verdict | Evidence |
| --- | --- | --- |
| Changed Node tests twice | PASS | 358 per run; 1006.31 and 1156.55 seconds. Includes application/preflight, chart and the complete installer refusal suite. |
| Scanner approval tests twice | PASS | 30 per run, including real CLI credential canaries and a controlled malicious GH_HOST. |
| Application/index Python tests twice | PASS | Three cases covering source, image, scope, inventory, forbidden licence, signatures, hashes, signed size/component, keyring and Debian versions. |
| Typecheck | PASS | All workspaces, package and dev stack; repeated the dev-stack project after the installer repair. |
| Changed JavaScript ESLint | PASS | No warnings or errors. |
| Manual type-aware installer ESLint | PARTIAL | The same 14 existing type-assertion errors before and after this change; zero warnings and no new diagnostics. Infrastructure is excluded by root ESLint. |
| Event catalogue | PASS | All 174 registered types agree. |
| Knip | PASS | Retains its two existing configuration hints. |
| Changelog and Markdown | PASS | Branch release note; Markdown without file arguments. |
| Extra README gate | FAIL | Four unchanged main files exceed their recorded allowances: server, events, models and protocol READMEs. |
| Fetch and rebase | PASS | Rebased onto `29d0d2cb7`; rebase completed. |
| Public privacy and secret scans | PASS | Ran before each source push; final evidence push checked separately. |
| Source CI | FAIL | [43875190763](https://github.com/elewa-git/opencrane-new/actions/runs/43875190763): all test shards and both fixture jobs passed. Checks/ci-ok fail on main's unchanged whole-stream-read mismatches in decision.ts and personal-tool-context.ts. No count was raised. |

Tests, builds, lint and typecheck used `nice -n 10`. No full local root suite ran.

## Fresh attempts and cleanup

| Attempt | Verdict | Observation |
| --- | --- | --- |
| First fresh Compose startup | PASS | Source `785cfa7b6`; all 37 observations. Both teardown commands returned zero. |
| First packaged attempt | FAIL | Preparation passed, but rendering refused the new application pin. Reproduced and fixed through the real installer as described above. Both teardown commands returned zero. |
| Repaired-source fresh Compose startup | FAIL | Website readiness passed in 44.647 seconds; the browser reported that the spending budget editor did not load. Saved private failure and step diagnostics before cleanup. Both teardown commands returned zero. |
| Repaired-source packaged attempt | PARTIAL | Upload/chat and malware refusal passed at both widths. Backup completed at sequence 92; catalogue and manifest were saved. Runner exited 130, its interruption code, before the broken-part check. The sender is not established. Retained records and screenshots privately; the final run logs signals and exit status in a separate process group. Both teardown commands returned zero. |
| Final fresh packaged claim | PASS | Separate claim and new namespace; exact-source preparation, installation, all operator/browser checks and both teardown commands passed. Exit zero; no signal recorded. Assertions and timeouts are unchanged. |

Each claim used the existing test sign-in key by file reference and the free stand-in
model, retained the fleet marker and waited before new work while load exceeded 10.
Only secondary stacks were used. The owner stack was not touched.

## Packaged observations

| Step | Verdict | Evidence |
| --- | --- | --- |
| Exact-source approvals and image preparation | PASS | Both successful CI artifacts matched the checkout and installed digest. |
| Fresh owned namespace and installation | PASS | Preparation, bootstrap, readiness and ownership checks completed. |
| Person signs in, uploads and chats at 1280/390 | PASS | Real SSO; clean upload HTTP 201; Ready attachment; answer reads Willow-47 from the PDF. |
| Malware refusal at both widths | PASS | HTTP 422 and visible refusal; only the clean file is saved. |
| Trigger installed CronJob and see completion | PASS | Manual Job completed in 62 seconds at sequence 92. |
| List the backup and read its manifest | PASS | One complete set; show verified its saved bytes before returning the manifest. |
| Check native content | PASS | Non-empty native event archive; all database dumps without role passwords; uploaded PDF bytes; all parts at sequence 92. |
| Broken file part fails visibly | PASS | A separate Job from the installed CronJob replaces only the object-owner mount. It reached Failed and logged reason parts. |
| No publication after failure and services recover | PASS | The checked catalogue is unchanged, with one set; server rollout completed. |
| Evidence saved before cleanup | PASS | Browser screenshots, manifest, both catalogues and operator output were saved while the install existed. Output was written as commands ran. Both answer pictures were inspected. |
| Package-down and down.sh | PASS | Both returned zero and released the namespace and slot. |

The complete backup is `1affe6ef-0ab8-4266-bbff-034a0da7e2ce`. The event, database and file parts contain
18,446, 335,266 and 2,165 bytes. Two file objects are recorded. The
[manifest](manifest.json) records checksums, all read-table positions and image/chart versions.
Native event bytes, SQL and file contents remained private and were removed with the slot.

Evidence: [operator output](operator-output.txt), [installation and approvals](installation.json),
[catalogue before failure](catalogue.json), [catalogue after failure](catalogue-after-failure.json),
[browser outcomes](outcomes.json), [1280 px answer](file-answer-1280.png) and
[390 px answer](file-answer-390.png). Clean-ready and malware-refusal pictures at both widths
are saved beside them. No earlier screenshot qualifies this final namespace.

Restore, computer homes, three event-log copies, off-machine durability and managed-cluster
qualification remain outside this slice. The PR remains a draft.
