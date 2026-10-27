# Candidate Node notice declarations

Date: 27 October 2026. Part of #15. Overall: PARTIAL. Live: NOT RUN.

The [declaration record](node-notices.json) covers all 43 sections in the actual
archived `/usr/local/LICENSE`, plus both Node preamble grants. It records 68
declaration entries with individual reasons. Ten references without enough terms stay
BLOCKED, including V8's external licence references and npm's dependency and
artwork references. Passing this bounded check approves none of those references
and does not prove their absence from the image.

The [original notice record](../p5-4-images4/notices.json) is unchanged; all its
43 rows remain NOT RUN. The [candidate record](../p5-4-images4/candidate.json)
is also unchanged. Its source is `0ba702c6e3ed062e7ff812875f9de873d41da4b3` and
its configuration digest is
`sha256:9a6bd564f72ff4e708289f11db14ceff4e93e00cf7d7ce2e0c172fb6085fbbc5`.
The new record binds that candidate file's checksum, source, configuration, local
index and full notice checksum. No image was rebuilt or published for this change.

## Bytes and declarations

Before recording the declarations, the existing candidate checker verified the
source archive, saved image, inspection, all-layer scan and notice hashes. A fresh
`git archive` of the recorded commit also reproduced the saved source checksum.
The archive's shipped notice and the saved notice both have SHA-256
`c738ae413cf561f174e34f6961f8ca458aae2369a73640dda6234c629b98bcc4`.
The generated `node-LICENSE.gz` fixture contains those exact 145,485 notice bytes,
compressed with a zero timestamp. Tests decompress it and check the full checksum;
no made-up licence text stands in for positive evidence. It is not a runtime file.

Each section keeps its original heading and checksum. Each grant records its
component, accepted licence identifiers, notice path and reason. The reasons also
record HdrHistogram's public-domain/CC0 alternative and the printed Autoconf
permissions alongside their GPL grants. ICU, libuv, Postject, V8 and heapdump have
separate entries for their nested grants. References without a usable grant keep
their own reason and BLOCKED status against the containing section's checksum.

The existing `check_bundled_notice` checks these entries. Only the exact ICU section
and named dictionary/install-script entries can accept NAIST-2003 and
HPND-sell-variant. The [NAIST terms](https://spdx.org/licenses/NAIST-2003.html) and
[HPND sell variant](https://spdx.org/licenses/HPND-sell-variant.html) identify those
printed grants. Their individual reasons apply the existing AGENTS.md bundled
notice rule. Application and general bundled licence rules are unchanged. A
reference to another licence file cannot approve an unknown component.

## Own checks

Environment: existing Linux host and tools, fresh `npm ci`, linked NATS and Lychee.
Tests, lint and typecheck use `nice -n 10`. The selected security suite uses the
requested `PG_TEST_URL`; it needs no projection database. No dev stack or model runs.
Tests were committed first in `56d986117`: the five new cases failed because the
Node checker and records did not exist yet. A second test commit, `4e21f8c44`,
exposed six cases where one blanket grant replaced separately printed grants under
valid section hashes. The checker now requires those grants separately.

| Check | Result | Observation |
| --- | --- | --- |
| Licence fixtures, twice | PASS | 35 cases each; missing/duplicate/changed sections, altered full notice/candidate, empty reasons, unsupported licences and blanket approval refuse. |
| Preflight fixtures, twice | PASS | 41 cases each, including the Python licence and promotion refusals. |
| Candidate and Node checks, twice | PASS | 455 components, 88 Debian main packages and 43 Node sections; unresolved references remain blocked. |
| Event security rules | PASS | All 460 cases pass; protected security and authority tests are unchanged. |
| Lint, typecheck, events, Knip and changelog | PASS | All requested gates pass; ESLint reports zero errors and 31 warnings in unchanged files. |
| Actual candidate promotion | FAIL | The existing promotion command refuses absent source-bound R3 approval. The positive Node fixture also checks that the shipped review still refuses. |
| Complete image licence/vulnerability clearance | NOT RUN | Other bundled declarations and unresolved references remain blocked. |
| Publication, fresh installation and live R3 | NOT RUN | Outside this change. |
| Full root suite | NOT RUN | Excluded by the task. |

The [operator notes](../../../infra/package/README.robot.md#package-image-promotion)
give the check command. Local logs are under `/tmp/p5-4-images5/`; original evidence
stays under `/tmp/p5-4-images4/`. No approved inventory, image/index/binary pin,
licence rule, recovery helper, cluster file or event/API contract changes.

## Exact grant and reference checks

Date: 27 October 2026. Source: test commit `be4d56c67` plus the checker and
notes in this change. Environment: existing Linux host, existing dependencies
and saved candidate evidence; no fresh installation.

The checker now requires the exact component and licence pairs under each
reviewed section checksum. The full notice checksum binds both preamble grants.
It also requires all ten unresolved section and name pairs exactly once. Reasons
and BLOCKED status remain required. Counts alone no longer accept substitutions.

The test-only commit ran before the fix. Its four new tests exposed 135 failed
subcases: deleted, duplicated or substituted references; changed component or
licence pairs; blanket MIT entries; and missing or changed preamble grants.
The corrected checker refuses every one of these edits.

| Own check | Result | Observation |
| --- | --- | --- |
| Licence and promotion fixtures, twice | PASS | 39 Python cases and 41 preflight cases per run, with the requested PG_TEST_URL and nice priority. |
| Saved candidate and Node checks, twice | PASS | Both full candidate checks and all 43 Node sections pass; complete image review remains PARTIAL. |
| Actual promotion, twice | FAIL | Both attempts exit 1; missing source-bound R3 approval still refuses. |
| Lint, typecheck, events, Knip and changelog | PASS | Required source checks run with nice priority. |
| Full root suite and live qualification | NOT RUN | Excluded from this correction. |

Logs are `/tmp/p5-4-images5-review-*.log` on this host. Promotion stays blocked.
No approved pin, registry publication or runtime behaviour changes.
