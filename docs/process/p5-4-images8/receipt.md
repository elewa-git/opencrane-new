# Candidate Node WebAssembly API terms

Date: 28 October 2026. Part of #15. Overall: PARTIAL. Live: NOT RUN.

The [record](wasm.json) resolves only `V8 Wasm C/C++ API`. The historical
[ten-reference record](../p5-4-images5/node-notices.json) and its checker stay
unchanged, as do the separate PCRE and Valgrind records. Seven references and
Corepack/Go/kubectl/agentgateway bundles remain blocked. Missing files or search
results prove no compiled absence. No general licence allowance changes.

## Exact source and distribution duties

The source is Node `22.23.1`, commit
`bd96dfbf0361576724b65322046e2ca9f9609cb9`. The
[licence](https://github.com/nodejs/node/blob/bd96dfbf0361576724b65322046e2ca9f9609cb9/deps/v8/third_party/wasm-api/LICENSE)
has 11,358 bytes and SHA-256
`c6596eb7be8581c18be736c846fb9173b69eccf6ef94c5135893ec56bd92ba08`.
It contains complete Apache-2.0 terms, sections 1–9 and the appendix.
Apache-2.0 is already in the OSI-approved list; no runtime dependency is added.
The appendix contains a template copyright notice, not another grant.

The reviewed `wasm.h` and `wasm.hh` headers have no additional licence or
copyright notice. `README.v8` identifies Apache 2.0, its LICENSE file, upstream
revision `6db391ee7121a0695602945d11001ea3e00b0afb` and `Shipped: yes`.
The pinned Git directory and authenticated source archive contain no NOTICE
file in this API directory. That observation applies only to this reference.
The [record](wasm.json) binds all four files to their reviewed checksums; compressed
fixtures keep their complete bytes. All four must match Git and release source.

Section 4 requires a copy of the full licence with distributed code, prominent
change notices on modified files, and relevant copyright, patent, trademark and
attribution notices in distributed source. If a work supplies NOTICE attribution,
that attribution must remain readable as section 4(d) describes. The absence of a
NOTICE here does not waive notices supplied elsewhere. The licence grants patent
rights with termination for the stated patent litigation. It grants no trademark
permission and retains its warranty disclaimer and liability limits. A short
reference or blanket MIT replacement cannot replace these terms. This repository
retains the terms for review; it does not change the candidate or approve delivery.

## Signed release and unchanged candidate

The checker reuses the PCRE release/tag signature, source/version/notice, official
Linux x64 binary and all-layer checks. Both signatures use release key
`890C08DB8579162FEE0DF9DB8BEAB4DFCF555EF4`. Signed archive, tag and keyring hashes
remain pinned in the new record. It compares Git with authenticated release source
for all four API files; their presence proves no claim about compiled code.

The unchanged [candidate](../p5-4-images4/candidate.json) has source revision
`0ba702c6e3ed062e7ff812875f9de873d41da4b3` and configuration
`sha256:9a6bd564f72ff4e708289f11db14ceff4e93e00cf7d7ce2e0c172fb6085fbbc5`.
Its checker verifies saved evidence, 455 components, 88 signed Debian-main package
versions and archived Dockerfile inputs. Node and notice bytes must match the
official release across every layer, including copies hidden by later layers.
This does not prove a reproducible build or complete distribution approval.

## Own checks and limits

Environment: existing Linux host, fresh `npm ci`, linked NATS and Lychee tools.
The first test commit was `69b3d3951`; its new test failed before the checker
existed. Malformed-archive/output fixtures also failed before CLI handling was
added. All tests and source gates use `nice -n 10`; no full root suite runs.
Safe local logs are under `/tmp/p5-4-images8/`.

| Check | Result | Observation |
| --- | --- | --- |
| Licence fixtures, twice | PASS | 65 cases per run; exact grants/references, changed inputs, blanket MIT and unproved absence refuse. |
| Preflight fixtures, twice | PASS | 41 cases per run, including licence and promotion refusals. |
| Saved source, signatures and candidate | PASS | Signed inputs, four API files, 455 components, 88 Debian main packages and all-layer Node bytes agree. |
| Event security rules | PASS | 460 cases; requested PG_TEST_URL, one worker; file unchanged. |
| Lint, typecheck, events, Knip, changelog | PASS | All requested source gates pass; lint has zero errors and 33 warnings. |
| Actual promotion | FAIL | Expected exit 1; direct assertion confirms “Package review needs an exact source revision” for the R3 prerequisite. |
| Other bundles and vulnerability clearance | NOT RUN | Seven references and other bundles remain blocked. |
| Registry, rebuild, publication, fresh installation and live R3 | NOT RUN | Outside this change. |

Fixtures separately exercise signatures, tag/version/commit/signer identity, source
agreement, official binary/notice checks, every-layer comparisons and Dockerfile
inputs. Small archive envelopes test these checks; they are not real releases.
Actual saved-evidence verification uses the pinned archives. Missing evidence,
malformed archives and failed dependencies print fixed refusal text, with no local
paths, source text or captured dependency output. No complete coverage claim is made.
Event/API/access code, both authority tests, pins, approved inventory and historical
records remain unchanged. Promotion still needs exact-source R3 proof and all
remaining licence, vulnerability, publication and fresh-install checks.
