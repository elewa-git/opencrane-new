# Candidate Node PCRE terms

Date: 28 October 2026. Part of #15. Overall: PARTIAL. Live: NOT RUN.

The [new record](pcre.json) resolves only `V8 PCRE test suite` by reviewing its
embedded terms. It does not prove absence of source, compiled or bundled copies.
The other nine references remain BLOCKED. The historical
[Node record](../p5-4-images5/node-notices.json), ten-entry checker and
[candidate record](../p5-4-images4/candidate.json) remain unchanged.

## Exact source and shipped bytes

The candidate source is `0ba702c6e3ed062e7ff812875f9de873d41da4b3`. Its configuration
is `sha256:9a6bd564f72ff4e708289f11db14ceff4e93e00cf7d7ce2e0c172fb6085fbbc5`.
The existing candidate checker verifies saved source, archive, scan, signed Debian
main index and notices. The new checker also reads every shipped layer, including
older copies. It requires exactly the reviewed Node binary and full notice.
Both candidate layers are checked; one contains files and one is empty.
The archived Dockerfile uses the existing pinned Node base for both build stages.
No image was rebuilt, changed or published.

Node is version `22.23.1`. The candidate's 124,835,376-byte `/usr/local/bin/node`
has SHA-256 `93956de2e59480474a7b46571da1651180b1a050cdf32641ebec4ce6e478e068`.
It is byte-identical to the binary in the official
[Linux x64 archive](https://nodejs.org/dist/v22.23.1/node-v22.23.1-linux-x64.tar.xz).
The official [source archive](https://nodejs.org/dist/v22.23.1/node-v22.23.1.tar.xz)
and binary archive match the verified contents of the
[signed release checksums](https://nodejs.org/dist/v22.23.1/SHASUMS256.txt.asc).

The source tarball omits this test file. That does not establish runtime absence.
The signed Git tag `v22.23.1`, object `af059a8d162418050857e202315220d1b79a6d03`,
identifies commit `bd96dfbf0361576724b65322046e2ca9f9609cb9`.
The [exact source file](https://github.com/nodejs/node/blob/bd96dfbf0361576724b65322046e2ca9f9609cb9/deps/v8/test/mjsunit/third_party/regexp-pcre/regexp-pcre.js)
contains 336,613 bytes and has SHA-256
`ef8e3b495c191bdacfa1e67ef7bb7b70f7ac713c932a008960d83c9d35ed8dbc`.
The Git source version header and full notice match the release tarball bytes.
The source, binary release and candidate full notice all have SHA-256
`c738ae413cf561f174e34f6961f8ca458aae2369a73640dda6234c629b98bcc4`.
This binds the reviewed test terms to the signed release used by the candidate;
it is not a claim of a reproducible Node build.

Both signatures verify using Rafael Gonzaga's release key fingerprint
`890C08DB8579162FEE0DF9DB8BEAB4DFCF555EF4`, named in the signed release's README.
The [upstream keyring](https://github.com/nodejs/release-keys/blob/main/gpg/pubring.kbx)
was fetched over authenticated HTTPS. The record pins its bytes and both signed
inputs. The checker captures signature output and withholds paths and dependency
errors on refusal. The source checkout was fetched from Node's upstream repository;
source file hashes also match an HTTPS fetch from the matching tag.

## Terms and limits

The embedded grant names the University of Cambridge, 1997–2007, for the basic
library and Google Inc., 2007, for the C++ wrapper. Both use the printed
three-clause BSD terms: source and binary redistribution with or without changes,
retained attribution, conditions and disclaimer, and no endorsement without
permission. The record requires these component/licence pairs separately.
BSD-3-Clause is OSI-approved; no application rule or bundled exception is extended.
The wrapper entry reviews the printed terms without claiming wrapper code ships.

The compressed fixtures contain the actual complete test source and version header.
The existing notice fixture contains the actual candidate notice. The test source
fixture retains both grants for inspection and distribution materials. The candidate
notice itself only points to the test file: full terms must accompany any distribution
of this code. This reference review does not grant complete image or release approval.
The reviewed grant applies even if copies were compiled or bundled; no missing-name
search is used as absence evidence. An unproved absence cannot pass this checker.

## Own checks

Environment: existing Linux host, fresh `npm ci`, linked NATS and Lychee; no stack,
registry or model call. Tests and source gates use `nice -n 10`.
Test commit `26ae9ba92` preceded implementation: all six new tests failed because
the new checker and record did not exist. No dependency or runtime code changes. No fresh installation.
The positive fixtures contain the actual reviewed bytes, rather than substitute
permissive terms. Application licences still require OSI approval; existing bundled
DFSG-free allowances and the Debian main OS rule are unchanged.

| Check | Result | Observation |
| --- | --- | --- |
| Licence fixtures, twice | PASS | 46 cases per run; changed source/version, notice, binary copies, archives, reference identities, grant pairs and unproved absence refuse. |
| Preflight fixtures, twice | PASS | 41 cases per run, including licence and source-bound promotion refusals. |
| Saved candidate, Node and PCRE checks, twice | PASS | 455 components, 88 Debian main packages, 43 Node sections; exact PCRE source, signatures and all-layer binary checks pass. |
| Event security rules | PASS | 460 cases; requested PG_TEST_URL, one worker. Security and both authority tests remain unchanged. |
| Lint, typecheck, event catalogue, Knip and changelog | PASS | All requested gates pass; Markdown, README and offline link checks also pass. |
| Actual promotion | FAIL | Expected exit 1: shipped approval lacks exact-source R3 proof. No promotion approval was added. |
| Complete licence/vulnerability clearance | NOT RUN | Nine references and other bundles remain unresolved. |
| Publication, fresh installation and live R3 | NOT RUN | Outside this change. |
| Full root suite | NOT RUN | Excluded by the task. |

Logs and upstream evidence are under `/tmp/p5-4-images6/`; candidate evidence remains
under `/tmp/p5-4-images4/`. Corepack dependencies, Go, kubectl, agentgateway,
vulnerability clearance, source-bound R3 approval and publication remain outstanding.
