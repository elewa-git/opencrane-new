# Candidate Node Valgrind header terms

Date: 28 October 2026. Part of #15. Overall: PARTIAL. Live: NOT RUN.

The [record](valgrind.json) resolves only `V8 Valgrind client API` after checking
the actual source terms. The historical ten references remain intact in
[images5](../p5-4-images5/node-notices.json). The
[PCRE resolution](../p5-4-images6/receipt.md) remains separate. Eight other
references stay BLOCKED. No filename search or missing source proves that compiled
or bundled code is absent. An unproved absence refuses resolution.

## Source and build inputs

The candidate source revision, configuration and archive checksums are unchanged
in [images4](../p5-4-images4/candidate.json). Its source is
`0ba702c6e3ed062e7ff812875f9de873d41da4b3`; its configuration is
`sha256:9a6bd564f72ff4e708289f11db14ceff4e93e00cf7d7ce2e0c172fb6085fbbc5`.
The new checker reuses images6's signed Node `22.23.1` release and tag checks,
version header, full notice and official Linux x64 binary comparisons. The tag
identifies commit `bd96dfbf0361576724b65322046e2ca9f9609cb9`. Both signatures use
release key `890C08DB8579162FEE0DF9DB8BEAB4DFCF555EF4`. The signed inputs, keyring,
source archive and binary archive retain their pinned checksums.

The shipped V8 notice names `src/third_party/valgrind/valgrind.h`. In the Node
repository this is
[`deps/v8/src/third_party/valgrind/valgrind.h`](https://github.com/nodejs/node/blob/bd96dfbf0361576724b65322046e2ca9f9609cb9/deps/v8/src/third_party/valgrind/valgrind.h).
It contains 231,048 bytes with SHA-256
`886cc6019a7c2858580aa9fa79108cf4c746c9de45433d99ae98b1be387a6d50`.
The adjacent
[`LICENSE`](https://github.com/nodejs/node/blob/bd96dfbf0361576724b65322046e2ca9f9609cb9/deps/v8/src/third_party/valgrind/LICENSE)
contains 2,439 bytes with SHA-256
`ebf25b8ce59c9e8883acd1ca75b6fc121937ca034f666c4077d2be739d2e1622`.
Both files must match Git, the authenticated source archive and the reviewed bytes.
Unlike the PCRE test file, both are present in the release source archive.

The complete header contains one grant, repeated in the adjacent licence file.
It names Julian Seward, 2000–2010, and covers this header only. The GPL-2.0
statements explicitly describe the rest of Valgrind. No further embedded grant
was found in this header. Its four conditions and disclaimer match
[SPDX bzip2-1.0.6](https://spdx.org/licenses/bzip2-1.0.6.html): retain source
attribution, conditions and disclaimer; represent origin honestly; mark altered
source; obtain permission before using the author's name for endorsement.
Product acknowledgement is appreciated, not required. This differs from the
advertising condition in the original four-clause BSD licence.

Accept this DFSG-free BSD-style term only for the header bundled inside
OSI-licensed Node/V8. It permits source and binary use and redistribution, with
or without changes, without restricting use or charging royalties. Its origin,
change-marking and no-endorsement conditions preserve attribution. This is the
bundled-parts allowance in AGENTS.md, not an OSI approval of this variant.
The application OSI list, general bundled rules and Debian main OS boundary are
unchanged. Both compressed fixtures retain the full reviewed bytes and terms.
Keep those terms with any distributed header; no blanket MIT summary replaces them.

The candidate check still verifies its saved archives, signed Debian main index,
455 components and archived Dockerfile. It compares the exact Node binary and
notice across every shipped layer, including copies hidden by later layers.
This binds the terms to the release used by the candidate; it does not prove a
reproducible Node build, code absence or complete distribution approval.

## Own checks and limits

Environment: existing Linux host, fresh `npm ci`, linked NATS and Lychee. No stack,
registry or model call. Test commit `58fc7b336` came first: all seven initial new
tests failed because the checker did not exist. No runtime dependency changed.
All suites and source gates run under `nice -n 10`.

| Check | Result | Observation |
| --- | --- | --- |
| Licence fixtures, twice | PASS | 55 cases per run; changed inputs, references, grants, blanket MIT and unproved absence refuse. |
| Preflight fixtures, twice | PASS | 41 cases per run, including licence and promotion refusals. |
| Saved candidate, Node, PCRE and Valgrind checks, twice | PASS | Authenticated inputs, 455 components, 88 Debian main packages, 43 Node sections and all-layer Node bytes agree. |
| Event security rules | PASS | 460 cases; requested PG_TEST_URL, one worker. |
| Lint, typecheck, event catalogue, Knip and changelog | PASS | All requested source gates; Markdown, README, offline links and privacy checks pass. |
| Actual promotion | FAIL | Expected exit 1. A direct prerequisite check confirms missing exact-source R3 approval still refuses. Unreviewed bundles gain no allowance. |
| Complete licence/vulnerability clearance | NOT RUN | Eight references and other bundles remain unresolved. |
| Publication, fresh installation and live R3 | NOT RUN | Outside this change. |
| Full root suite | NOT RUN | Excluded by the task. |

The new fixtures exercise signature calls and refusal, Git extraction, source
archive equality, official binary comparison, complete candidate-check invocation,
every-layer iteration/comparison and archived Dockerfile inputs. They also check
top-level sequencing and fixed CLI refusals. Small archive envelopes test wiring;
they are not authentic releases. Positive licence fixtures contain the actual full
source, notice and terms. Saved evidence checks use the actual pinned archives.
Inherited guard gaps outside this scope remain as described in images1–6 reviews,
including signed-checksum membership, tag identity, signer README membership and
individual archive member selection. No complete mutation-coverage claim is made.

No event or API fields are added; RISKY_FIELD_NAME has no new field to assess.
Security rules and both protected authority tests are unchanged. Access and event
paths are untouched. Errors print fixed text and withhold dependency output,
source text and local paths. Logs remain under `/tmp/p5-4-images7/`.

Corepack/Go/kubectl/agentgateway bundles, eight references, complete-image
vulnerability clearance, exact-source R3 proof, publication and fresh-install
qualification remain outstanding. Approved images, inventory and binary pins,
historical records and PCRE's resolution remain unchanged.
