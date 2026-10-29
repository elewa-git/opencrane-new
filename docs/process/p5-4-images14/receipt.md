# Candidate npm inventory

Date: 29 October 2026. Part of #15. Overall: PARTIAL. Live: NOT RUN.

The [record](npm.json) keeps npm approval BLOCKED. The compressed
[inventory](inventory.json.gz) lists exact paths, file sizes and SHA-256 hashes,
links and their targets, observed package names, versions and licence labels,
and licence/notice file hashes. These labels are observations, not reviewed grants.
Missing metadata and packages without their own notice are listed separately.
Copied code may have no package metadata; its origin and grants remain unresolved.
Service, logo, font and trademark findings remain unresolved.

## Source and candidate

The checker reuses unchanged [Node authentication](../p5-4-images6/check-pcre.py)
and [candidate checks](../p5-4-images4/check-candidate.py). Retained hashes were
checked before reading the saved files. Node `22.23.1` has signed tag `v22.23.1`,
commit `bd96dfbf0361576724b65322046e2ca9f9609cb9` and release signer fingerprint
`890C08DB8579162FEE0DF9DB8BEAB4DFCF555EF4`. The new record binds the candidate
record and retains authenticated source, official archive and signature hashes.

Authenticated package bytes report npm `10.9.8`. Git and release source must match
2,148 exact source entries. Official and all candidate layers must match 1,966
official entries, including both launcher links: 232 package manifests and 195
notice files. There are 37 manifests missing metadata and 43 without their own notice.
The 184 source-only test files and two installed launcher links remain BLOCKED
differences. Both candidate layers yield zero paths in this npm tree and launcher
scope. The archived Dockerfile removes those paths before the final copy. The inventory
retains that empty observation and all 1,966 missing paths. The real check must refuse
the missing tree. This proves neither copied-code absence nor a reproducible Node build.

The 11 KB [fixture](npm-sample.tar.gz) keeps actual npm metadata, its full licence,
a complete dependency and both launchers. Hostile envelopes use these bytes.
Saved real evidence checks the whole tree separately. No paths are extracted or links followed.

## Own checks

The failing fixture run was committed before implementation. Exact package and path
sets are checked, including duplicate, missing, changed and older-layer entries.
The checks also refuse changed versions, notices, link targets and mismatched copies.
Malformed archives, encoding, imports and decompression return fixed stderr and empty
stdout without local paths or tracebacks.

- PASS — Clean `npm ci`, linked tools, lint, typecheck, event catalogue, knip and changelog check.
- PASS — Seven offline Python fixtures through the CI wrapper, twice; 460 unchanged security tests.
- PASS — Existing 77 licence and 41 preflight fixtures; documentation checks.
- PASS — Retained signatures, source/official npm trees, candidate authentication and archived build inputs.
- FAIL — Real candidate npm equivalence: all 1,966 expected paths are missing. The refusal is expected
  and asserted, with exit 1, empty stdout and exactly the fixed stderr line.
- PASS — Promotion still refuses the saved source/inspection/scans; the unchanged prerequisite
  separately refuses missing exact-source revision evidence.
- NOT RUN — Full root suite and live qualification.

Complete dependency grants, copied-code origins, missing metadata and source differences
remain BLOCKED. Complete image licensing and vulnerabilities, registry publication,
exact-source R3 approval and fresh installation remain outstanding. Registry operations,
rebuilds, stacks, model calls and live qualification: NOT RUN. Historical records,
approved inventory, runtime pins, promotion gates and product access code are unchanged.
