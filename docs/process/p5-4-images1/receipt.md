# Package image promotion checks

Date: 26 October 2026. Part of #15. Overall: PARTIAL.
The shipped server/web image remains unchanged and has no R3 approval.
Live qualification: NOT RUN. No stack, model call or owner-installation change.

## Source and image

PR 5a (#725) merged as `5557c51ba707bbcfb96b2e510193f9fe44c7519a`.
PR 5b (#738) merged as `ced4d8002413382f369d99901eb55a4c9e480909`.
Both are ancestors of the branch base, `834e9209d`.
The promotion-check implementation is `1b7f5df9d`.
The build uses source `f076a6f391ffa5077b06724fe53e8f2edfb17240`, which also
contains the bootstrap readiness fix from #739.
Tests were committed first as `b8c821d9f`; the new label assertion and four
preflight cases failed, and the promotion cases could not find the new checker.
A second failing-first commit, `f64f4c829`, covers Docker identifying an image
by its OCI index while Syft identifies its configuration. Both must name the
same repository digest.

Environment: Linux, Node 22.23.3, fresh `npm ci`, linked NATS and Lychee tools.
Existing Docker and Syft tooling are reused. All builds and test commands run
under `nice -n 10`. No new application dependency is added.

The produced local OCI index is
`sha256:ac6943a9561bcc4cbcbaa3b95d94fd77d9a7f833296d99fba7c38030ddf4b176`.
Its image configuration digest is
`sha256:89c30dc709b2abd51b55e878ed144370dc96591989ba4ac27484bcd0f5aa64d7`.
These identify a local, unapproved build, not a published replacement.
The all-layer Syft JSON SHA-256 is
`6ca79770ba6100a30a24af905b2e4dd69873a7a752ddfaa18f120b281efcd9ca`.
The scan contains 475 npm packages, 90 Go modules, 88 Debian packages and Node.

## Checks

| Check | Result | Observation |
| --- | --- | --- |
| Private registry | FAIL | The existing loopback endpoint on port 5001 reset the connection; curl returned 56 and HTTP 000. No repair or alternate registry was attempted. |
| Local image build | PASS | The exact source label, bootstrap bytes and owner-bootstrap bytes match the committed source. |
| Bootstrap imports in the actual image | FAIL | The owner-bootstrap configuration imports `infra/dev-stack/private-directories.ts`, which the Docker build context excludes. |
| All shipped layers | FAIL | Syft 1.54.0 found 654 components; the existing inventory has 454. There are 202 extra entries and two missing entries. Unknown and non-OSI licence declarations refuse. |
| Signed Debian-main membership | PASS | All 88 installed Debian package/version pairs match the authenticated bookworm main index. |
| Bootstrap source tests | FAIL | 34/35 passed. The late stream-create reply case found one stream after the fixture deleted it; its setup assertion expected zero. This is retained as FAIL and was not retried or repaired here. |
| Event security rules | PASS | All 449 tests passed in the same selected Vitest run. |
| Source production dependency audit | PASS | npm audit with `--omit=dev --audit-level=high` reported zero High/Critical, one low and three moderate findings. This does not clear every shipped layer. |
| Complete-image vulnerability scan | NOT RUN | No complete-image vulnerability clearance is claimed. |
| Promotion and licence tests, twice | PASS | 19 Python tests and 29 preflight tests passed in each final run. Preflight also executes the Python suite. |
| Installer fixtures, twice | PASS | Both runs passed all 259 tests, with zero skips. |
| Typecheck | PASS | All workspaces, package and dev-stack tooling passed. |
| Event catalogue, Knip and changelog | PASS | All 155 event names agree; both explicit lint commands passed. |
| Lint | PASS | All stages passed with CI's `NODE_OPTIONS=--max-old-space-size=8192`. The initial default-heap run was stopped without a result. |
| Publication and promotion | NOT RUN | The existing registry is unavailable. No replacement digest or R3 approval is recorded. |
| Fresh install and live R3 | NOT RUN | Source fixtures cannot qualify a running package. |
| Full root suite | NOT RUN | Excluded by the task. |

The real bootstrap entry point loaded and refused absent replica settings with
its fixed error. The separate configuration import then failed on the missing
file, with networking disabled and no mounted settings. No bootstrap success is
claimed. The removed computer source and base-image npm files remain in earlier
shipped layers. Syft reports empty licence expressions for `@opencrane/computer`
and `qrcode-terminal`, CC-BY-3.0 for `spdx-exceptions`, and CC0-1.0 for
`spdx-license-ids`. These need a layer-content fix and a new complete review;
changing the checker's expected pin cannot clear them.

The existing Node notice at `/usr/local/LICENSE` still has SHA-256
`c738ae413cf561f174e34f6961f8ca458aae2369a73640dda6234c629b98bcc4`.
Its permitted bundled library notices and public-domain ICU time-zone data remain
recorded with their reasons in `licence-inventory.json`. No new exception is added.

The Debian check reverified the cached signed bookworm `InRelease` with `gpgv`.
The keyring SHA-256 was
`506b815cbb32d9b6066b4a2aa524071e071761e7e7f68c3ac74f3061ba852017`;
the signed release SHA-256 was
`77737fa4b34f2693e982cc9ee35736816c35a7778fc2d326cc1bbf5b301fe1aa`.
The main `Packages.xz` SHA-256,
`9e0b5aabb2465b3d2e7a7fe27f9913846277833f7a2826e7767acccff5b588c5`,
matched the signed release. Every `dpkg-query` pair in this image matched it.
These are the [existing snapshot files](../p5-1-local.md#debian-main-check-after-review),
rechecked locally; no fresh index download is claimed.

The new promotion mode compares the expected source commit with the image label,
review and inventory. It binds Docker's inspected image to the server/web pins,
then checks the scan's image identity, all-layer scope, checksum and exact contents.
The ordinary licence and signed-index checks remain required. Preflight requires
the exact source revision alongside the existing R3 compatibility record.
Made-up successful evidence is source evidence only.

Computer, NATS, PostgreSQL and OpenFGA pins remain unchanged. The existing reviewed
image and licence inventory remain unchanged. No chart, capture, computer or
memory-lane image file changes. No event or API fields change; the exact
`RISKY_FIELD_NAME` rule was read and the protected tests remain unchanged.

The build command was `nice -n 10 docker build`, using
`--build-arg SOURCE_REVISION=f076a6f391ffa5077b06724fe53e8f2edfb17240`,
`-f infra/package/Dockerfile` and local tag `opencrane-package:p5-4-images1`.
Syft used `scan docker:opencrane-package:p5-4-images1 --scope all-layers`.
The existing licence checker with both actual scans refused the first unknown
licence. Its unchanged inventory pin also prevents this candidate from promotion.

The selected tests use `PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`.
Vitest ran only `infra/package/bootstrap.test.ts` and
`libs/events/test/security-rules.test.ts`, with two workers.
The Node runs use `--experimental-strip-types --test --test-concurrency=1`
for `cnpg-install.test.mjs`; `preflight.test.mjs` and `licences.test.py` run separately.
These tests do not need a projection database. No full root suite ran.

Local logs are under `/tmp/p5-4-images1/` and `/tmp/p5-4-images1-*.log`.
CI is not awaited after the draft PR is opened. Open Critical/High findings and
unknown runtime licences block release qualification.
