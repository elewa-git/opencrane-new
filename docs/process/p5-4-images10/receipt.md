# ICU libtabe attribution

Date: 29 October 2026. Part of #15. Overall: PARTIAL. Live: NOT RUN.
Base: `8b93ce3c1`. Failing-first test commit: `1f999a9ae`.

The [record](libtabe.json) checks only `libtabe Chih-Hao Tsai attribution`.
It stays BLOCKED. No permission from Tsai has been established, nor proof that
another holder may license his contribution. Copyright and contact details grant
nothing. Another author's grant and absence from the final filesystem prove no
permission. Seven references remain unresolved, including this one.

## Exact source and terms

Node is `22.23.1`, signed tag `v22.23.1`, commit
`bd96dfbf0361576724b65322046e2ca9f9609cb9`. The unchanged
[candidate](../p5-4-images4/candidate.json) has source
`0ba702c6e3ed062e7ff812875f9de873d41da4b3` and configuration
`sha256:9a6bd564f72ff4e708289f11db14ceff4e93e00cf7d7ce2e0c172fb6085fbbc5`.
The [checker](check-libtabe.py) reuses release/tag signatures with key
`890C08DB8579162FEE0DF9DB8BEAB4DFCF555EF4`, signed archive checksums, Node version
and full notice, official binary and every candidate layer. It also keeps the
455-component inventory, 88 authenticated Debian main versions and archived
Dockerfile checks. No reproducible-build or compiled-absence claim is made.

The retained files match Git and the authenticated release archive:

| Source path under Node | Bytes | SHA-256 |
| --- | --- | --- |
| `deps/icu-small/LICENSE` | 27,718 | `e55522d81edc687a341a4411e0776e54ca654e90147f354a90458aaced4116af` |
| `deps/icu-small/source/common/unicode/uvernum.h` | 6,480 | `be53eaf56f3f03870639ec0b40d4c16f9b60fa5d44196b96ed3084717084882f` |

The version header identifies ICU `78.2`. The complete compressed fixtures keep
all licence terms and attribution. The record also pins their compressed bytes,
both Node archives, signed checksums, tag, release keyring and historical record.
The existing full Node notice fixture remains byte-for-byte unchanged.

In the pinned [ICU licence](https://github.com/nodejs/node/blob/bd96dfbf0361576724b65322046e2ca9f9609cb9/deps/icu-small/LICENSE),
lines 90–141 describe `cjdict.txt`, combining word lists including libtabe and
IPADIC. Lines 143–216 retain the entire `COPYING.libtabe` block. The two preceding
BSD grants name TaBE Project/Pai-Hsiang Hsiao and Academia Sinica's laboratory.
Each permits source and binary redistribution with or without changes, subject
to retained attribution, conditions and disclaimer and no endorsement. Those
OSI BSD-3-Clause acceptance reasons remain in the unchanged
[Node declarations](../p5-4-images5/node-notices.json). They do not establish
Tsai's permission. No new grant is accepted here.

ICU lines 212–214 contain Tsai's 1996 copyright, Beckman Institute/University of
Illinois affiliation and public contact details. The libtabe block then ends.
Node's [full notice](https://github.com/nodejs/node/blob/bd96dfbf0361576724b65322046e2ca9f9609cb9/LICENSE)
repeats this block at lines 507–580, with the attribution at 576–578. Its ICU section
retains SHA-256 `1dcebd6ab53b3562845796912ab65afb45186883808e692d8d38a87631ed9d48`.
Searches of the pinned Node tree for libtabe and Chih-Hao found only these notices;
that observation proves neither permission nor absence of compiled or bundled data.
The missing proof remains an applicable grant from Tsai, or documented authority
to license his contribution. ICU's general licence does not resolve that gap here.

## Own checks and limits

Environment: existing Linux host, fresh `npm ci`, linked NATS and Lychee tools.
No development stack or model call. All checks use `nice -n 10`. The selected
security suite uses the requested `PG_TEST_URL` and needs no projection database.
Logs are under `/tmp/p5-4-images10/`. Tests were committed first: seven new cases
failed because the checker did not exist; three inherited fixtures passed.

The fixtures use authentic complete licence, notice and header bytes. Small
synthetic archives exercise comparison and refusal paths; they are not signed
releases. Reused fixtures cover signature, tag, signer and signed-checksum changes,
official binary/notice comparisons and archived build inputs. New fixtures cover
changed author/section/terms, missing/duplicate references, blanket MIT replacement,
Git/release mismatch, failed historical checks, extra/changed older-layer copies,
hostile archive entries, damaged compression and dependency failures. Refusals
require fixed stderr and empty stdout, without host paths or tracebacks.
No complete guard-coverage claim is made.

| Own check | Result | Observation |
| --- | --- | --- |
| Attribution fixtures, twice | PASS | 12 Python cases through the existing Vitest glob. |
| Historical licence fixtures, twice | PASS | 77 cases each; files unchanged. |
| Preflight fixtures, twice | PASS | 41 cases each, including licence and promotion refusals. |
| Event security rules | PASS | All 460 cases; protected file unchanged. |
| Events, Knip and changelog | PASS | Required explicit checks pass. |
| Saved signed evidence | PASS | Exact ICU source, signed Node/tag, official binary and every candidate layer agree. |
| Typecheck | PASS | All workspaces, package tools and development-stack tools. |
| Lint | PASS | All stages; zero errors and 33 warnings in unchanged code, with a 6 GB Node heap. |
| Actual promotion | FAIL | Expected exit 1, empty stdout and fixed refusal; prerequisite fixture requires an exact source revision. |
| Full root suite, registry, rebuild and fresh/live qualification | NOT RUN | Outside this bounded source review. |

An extra Markdown command included the plain changelog fragment outside the
configured documentation scope and failed its heading rule. The corrected command
passes all 382 documents in the configured scope. `npm ci` reported seven High
audit findings; no audit fix or complete-image vulnerability clearance was attempted.

Historical records/checkers and PCRE, Valgrind and Wasm resolutions are unchanged.
Corepack ancestry/grants, Go/kubectl/agentgateway bundles and the other six references
remain outstanding. No dependencies, inventory/pin or promotion gate changes.
No event/API/access code changes; security rules and both authority tests stay
unchanged. Complete licence/vulnerability clearance, publication, exact-source R3
proof and fresh installation journeys still block release qualification.
Registry, rebuild, publication, full root suite and fresh/live qualification: NOT RUN.
