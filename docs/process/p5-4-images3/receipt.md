# Packaged bootstrap imports

Date: 27 October 2026. Part of #15. Overall: PARTIAL.

This change adds one file to the Docker context exceptions:
`infra/dev-stack/private-directories.ts`. The owner setup imports it through
`config.ts`. The other development files remain excluded. No host settings are
copied or mounted. The approved inventory, reviewed images and shipped pins stay
unchanged. Recovery helpers and chart files are outside this change.

Tests were committed first in `538a10303` and `fe48a7cc9`. The previous saved
image fails both the recursive import check and the real entry-point fixture.
Its other seven archive tests pass. A separate Docker context build refuses the
missing file, and the new check in the existing bootstrap suite fails on its
missing exception. These are expected failing-first results.

The candidate is built from a Git archive of committed source
`b2cfda681` extracted to a temporary directory, using `nice -n 10 docker build`, the existing Docker daemon
and the
unchanged package Dockerfile. The local tag is `opencrane-package:p5-4-images3`.
The build, tests, lint and typecheck use nice priority. Dependencies were installed
with a fresh `npm ci`; NATS and Lychee use the existing linked tools.

## What the checks prove

The archive check follows relative runtime imports recursively from both setup
programs after removing TypeScript types. Every visited file must match the
source checkout. Removing any of the four imported modules must refuse, even
when `bootstrap.ts` is still present. Errors withhold module contents, host paths
and fixture values.

The entry-point fixture first loads the real service packages with Node's normal
resolution. It then replaces service calls with made-up replies. It runs the real
`bootstrap.ts` and its real owner subprocess. The owner writes two fixture events
and a private completion marker. The parent must reach its final owner-ready
update. An early settings refusal cannot pass.

Containers have no network, a read-only root filesystem and only a temporary
writable directory. The only mounted input is the test loader. Identity and
service-account reads use made-up data; no cluster, real identity setup, dev
stack or model is used. The loader is excluded from the shipped image.
The image keeps its user, entry point, workspace links and Node trust roots.
All seven deleted paths must remain absent from every saved layer.

An initial build passed the Git tar archive directly to Docker. That bypassed
Docker's context exclusions. The new narrow-content check correctly refused it
for including extra development files. Its import and entry-point checks passed,
but that image is not accepted. The replacement build uses an extracted committed
checkout so Docker applies `.dockerignore`. No private host input entered either
build.

## Results

The [image record](image.json) binds the saved archive checksum, local image index,
configuration digest and exact source label. The accepted local index is
`sha256:38551c78795f5d0efac41a8577e60f396493499d2f7cbd2702e5672e78b2f57e`.
It is not a published replacement for the approved image.

| Check | Result | Observation |
| --- | --- | --- |
| Original context and archive refusal | PASS | Missing-import checks fail before the one-line allowlist fix. |
| Committed directory-context build | PASS | Docker applies the context exclusions. No Dockerfile, base image or binary pin changes. |
| Archive checks, twice | PASS | All nine tests pass in both runs. The archive identifies the exact image exercised by the container test. |
| Runtime imports | PASS | All six relative modules match source. Removing each of the four imported files refuses with fixed output. |
| Real entry point, twice | PASS | Bootstrap and the owner subprocess finish with synthetic settings and services. The final ready update and child completion marker are required. |
| Runtime contents and settings | PASS | Non-root user, entry point, home, workspace links and Node trust roots pass. Only the allowed package and dev-stack files ship. |
| Deleted paths across every layer, twice | PASS | All seven are absent. One layer contains files; the other is empty. |
| kubectl and agentgateway startup | PASS | Both binaries start in the accepted image with no network. |
| Bootstrap source suite, twice | PASS | All 36 tests pass in both runs. The final import-parser setting also passes its focused test twice. |
| Event security rules | PASS | The first selected run passes all 496 bootstrap and security cases together. Protected tests are unchanged. |
| Typecheck | PASS | All workspaces and infrastructure checks pass; package typecheck also passes after the last parser adjustment. |
| Event catalogue | PASS | All 156 names agree. |
| Knip and changelog | PASS | Both explicit checks pass. |
| Licence and promotion source fixtures | PASS | All 20 Python cases and 29 preflight cases pass. These use the unchanged approved inventory. |
| Lint | PASS | Every stage passes with the configured 8 GiB Node heap. Existing warnings remain. |
| Candidate inventory, notices and remaining declarations | NOT RUN | A separate follow-up must include authenticated Debian-main evidence. |
| Publication, promotion and vulnerability clearance | NOT RUN | No registry action or release clearance is attempted. |
| Fresh R3 installation and live qualification | NOT RUN | Synthetic setup cannot qualify an install. |
| Full root suite | NOT RUN | Excluded by the task. |

A first documentation check rejected a fixed container-home literal. The fixture
now compares the home directory with the operating system's account information.

Commands use the existing bootstrap suite with one Vitest worker and the supplied
`PG_TEST_URL`. These selected suites need no projection database. Archive tests use
`PACKAGE_IMAGE_NAME`, `PACKAGE_IMAGE_ARCHIVE` and the exact `PACKAGE_IMAGE_REVISION`
as shown in the [operator notes](../../../infra/package/README.robot.md#package-image-promotion).
Local logs and archives are retained under `/tmp/p5-4-images3/`.

The original [34/35 bootstrap failure](../p5-4-images1/receipt.md#checks) remains
FAIL in its original receipt; later passes do not erase it.

Complete candidate inventory, bundled notices and remaining declarations follow
with authenticated Debian-main evidence. Registry publication, promotion,
complete-image vulnerability clearance, fresh R3 installation and all live
qualification remain NOT RUN. The full root suite is NOT RUN as requested.
Source fixtures do not qualify a running installation.
