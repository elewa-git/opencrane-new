# npm source difference in the saved image

Date: 8 November 2026. Part of #15. Overall: PARTIAL. Live: NOT RUN.

The [difference record](difference.json) binds the earlier
[npm inventory](../p5-4-images14/inventory.json.gz) and the exact saved
[candidate record](../p5-4-images4/candidate.json) by SHA-256. The candidate
record binds the archived Dockerfile and image layers. The source is Node
22.23.1, signed tag `v22.23.1`, commit
`bd96dfbf0361576724b65322046e2ca9f9609cb9`. The official Linux x64
archive has the recorded release signature and SHA-256. The candidate's
source revision is `0ba702c6e3ed062e7ff812875f9de873d41da4b3`. Its
configuration digest is
`sha256:9a6bd564f72ff4e708289f11db14ceff4e93e00cf7d7ce2e0c172fb6085fbbc5`.
Its index digest is
`sha256:835a2664d9cc10647c5f5da587cdb1326fb9e3bbf08c458e93d17dcb7af116ac`.

The [checker](check-difference.py) repeats the saved Node signature, Git and
release-source checks. It compares each npm path, size, hash and link target
with the official archive. It checks both candidate layers and the archived
Dockerfile. It hashes the candidate and source archives again after reading them.
It extracts no archive path and follows no link. A changed or unsupported input
returns one fixed error without a local path.

## Results and boundary

| Exact set | Official archive | Candidate layers | Status |
| --- | --- | --- | --- |
| 184 source-only npm test files | Absent | Absent | PARTIAL: this exact path set is proved |
| `bin/npm` and `bin/npx` launcher links | Present | Absent | PASS: this exact link set is proved |
| All 1,966 official npm entries | Present | Absent | BLOCKED: candidate inventory refuses |

The archived Dockerfile removes the npm tree and both launcher links before
the final copy. The saved layer bytes confirm their absence in this candidate.
The result says nothing about other copied code or dependencies. Licence labels
grant no approval. Missing package metadata and own notices, copied-code origins,
other npm/Node/Corepack/Go grants, complete image licences, vulnerability
clearance, exact-source R3 and promotion remain BLOCKED. Existing pins,
approved inventory, historical records and promotion gates are unchanged.

## Own checks

- PASS — Clean `npm ci` and linked local NATS and lychee tools.
- PASS — Eight Python fixtures through Vitest, twice. They include an actual
  signed-source npm test file and the official launcher-link rows. Removing each
  authentication, source, candidate, layer, recipe or archive recheck guard in
  turn made its matching refusal test fail; the checker was restored each time.
- PASS — Exact source, official archive, archived Dockerfile and both saved
  candidate layers. The new checker returned the bounded results above.
- PASS — Scoped ESLint, Markdown lint, typecheck, event catalogue, Knip and
  changelog check.
- PASS — 460 unchanged security rules with a disposable PostgreSQL database.
- FAIL as expected — The original npm inventory checker refuses the candidate's
  missing 1,966-entry tree with its fixed error.
- NOT RUN — Full root suite, image rebuild, publication, stack, fresh install
  and live qualification.

The new checker does not approve a licence, image or release. It does not
publish or change the candidate.
