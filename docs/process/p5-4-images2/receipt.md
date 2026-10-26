# Package image layers

Date: 26 October 2026. Part of #15. Overall: PARTIAL.

This change builds follow-up part 1 only: the cleaned runtime filesystem is copied
into one layer with filesystem contents. A complete candidate inventory for 455
components, its notices and signed-index evidence would take this change beyond
about 600 changed lines. That work remains separate. The missing bootstrap import
is also deferred, as requested when splitting. No expected image pin or licence
exception changes.

The branch starts at `90a95dff6`, the merged promotion checks. Tests were committed
first as `c268dba88`. The new archive tests failed against the previous local image:
all seven removed paths remained in its 11 layers. The runtime settings and required
files passed. A separate promotion fixture confirms that an extra npm package from
an older layer refuses even when the scan checksum and image identity match.

The build source is `4bf20a6f004c635054fab291d3b84a801c26e83c`.
The final stage copies the cleaned filesystem from
the runtime build stage. It restores Node's entry point, user, working directory,
version variables and default command. The base image and downloaded binary pins
are unchanged. No new application dependency is added.

Environment: Linux, Node 22.23.3, fresh `npm ci`, linked NATS and Lychee binaries.
The build uses the existing Docker daemon. Tests and checks run under `nice -n 10`.
No dev stack, registry publication, model call or owner-installation change occurs.

## Image and scan

The local OCI index is
`sha256:44abeaf67aa192b4da43f998668ad5cc81b83e2a34f42af14d7468b0342b7a71`.
Its configuration digest is
`sha256:98f3c38d9c778d869c368dcd4b26c60320fb1611fea7b1a04aa2cd21f62d5c5c`.
These identify an unapproved local build, not a replacement for the published pin.
Syft 1.54.0 scanned it with `--scope all-layers`. The JSON SHA-256 is
`15f6328be1cda07addbb15e3ef7e468598bc317189610fb2fb5ed4c7cf2c1ec3`.

| Comparison | Previous local image | New local image |
| --- | --- | --- |
| Scanned components | 654 | 455 |
| npm packages | 475 | 276 |
| Go modules | 90 | 90 |
| Debian packages | 88 | 88 |
| Node binary | 1 | 1 |
| Extra entries against the 454-entry inventory | 202 | 3 |
| Missing entries against that inventory | 2 | 2 |

The scan has 199 fewer entries after flattening the cleaned filesystem.
No new entry appears compared with the previous all-layer scan.
`@opencrane/computer`, `qrcode-terminal`, `spdx-exceptions` and `spdx-license-ids`
are absent. No scanned declaration fails the existing application licence rules.
This does not replace the complete inventory and notice review.

The remaining extra entries are `@opencrane/demo-mcp` 0.1.0,
`follow-redirects` 1.16.1 and `zod` 4.6.6. The missing entries are the old
`follow-redirects` 1.16.0 and `zod` 4.6.5. The approved inventory remains unchanged;
the candidate is not promoted by changing expected values to match it.

## Checks

| Check | Result | Observation |
| --- | --- | --- |
| Failing-first layer tests | PASS | Previous image fails all seven removed paths and the single-layer assertion. Tests committed before the Dockerfile change. |
| Promotion and licence tests, twice | PASS | All 20 Python tests pass in each run. |
| Preflight tests, twice | PASS | All 29 tests pass in each run, including the Python suite. |
| Event catalogue and Knip | PASS | All 155 event names agree; unused-code check passes. |
| Local image build | PASS | Source label and both bootstrap file hashes match the committed source. |
| Saved layer tests, twice | PASS | All four tests pass in each run. One layer holds files; Docker adds one empty layer for `WORKDIR`. All seven deleted paths are absent from both. |
| Node and binary startup, twice | PASS | Non-root user, working directory, home, workspace link and Node trust roots pass. kubectl and agentgateway report their versions with networking disabled. |
| Bootstrap source tests, twice | PASS | All 35 tests pass in each run. |
| Event security rules | PASS | All 449 tests pass; protected rules are unchanged. |
| Bootstrap entry point, twice | PASS | Actual image loads the entry point and refuses absent replica settings with the fixed error. This is not successful setup. |
| Actual bootstrap configuration imports, twice | FAIL | `private-directories.ts` remains outside the build context. Follow-up part 2 is still required. |
| Authenticated Debian-main membership | PASS | All 88 installed package/version pairs match the signed bookworm main index. |
| Typecheck | PASS | All workspaces, package tools and dev-stack tools pass. |
| Changelog | PASS | Explicit fragment check passes. |
| Lint | PASS | All stages pass with `NODE_OPTIONS=--max-old-space-size=8192`. ESLint reports zero errors and 27 existing warnings. |
| Actual image licence comparison, twice | FAIL | Scan differs from the approved inventory by three extra and two missing entries. No licence rule is relaxed. |
| Actual image promotion, twice | FAIL | No source-bound R3 review exists for this candidate. Existing promotion checks refuse. |
| Complete candidate inventory and notice refresh | NOT RUN | Follow-up part 3 remains separate. |
| Complete-image vulnerability clearance | NOT RUN | No release clearance is claimed. |
| Publication, fresh install and live R3 | NOT RUN | Outside this part. |
| Full root suite | NOT RUN | Excluded by the task. |

The initial single-layer test counted Docker's empty `WORKDIR` layer as a failure.
The corrected test counts layers containing files and still scans every layer.
It passes twice against this build and still refuses the previous image.
An initial startup probe assumed `/etc/ssl/certs/ca-certificates.crt` existed.
It is absent from both old and new images. The corrected probe checks Node's
bundled trust roots; no certificate files or image bytes were changed for that probe.
An extra Markdown command included the headingless changelog fragment and failed
the heading rule. The normal documentation scope and the separate fragment check pass.

## Debian evidence and notices

`gpgv` reverified the cached bookworm `InRelease` signatures. Its SHA-256 is
`77737fa4b34f2693e982cc9ee35736816c35a7778fc2d326cc1bbf5b301fe1aa`.
The keyring SHA-256 is
`506b815cbb32d9b6066b4a2aa524071e071761e7e7f68c3ac74f3061ba852017`.
The main `Packages.xz` SHA-256 is
`9e0b5aabb2465b3d2e7a7fe27f9913846277833f7a2826e7767acccff5b588c5`.
Its checksum and size match the signed release. Every installed `dpkg-query`
package/version pair is present. These are the
[existing snapshot files](../p5-1-local.md#debian-main-check-after-review),
authenticated again locally; no fresh index download is claimed.

The Node notice at `/usr/local/LICENSE` retains SHA-256
`c738ae413cf561f174e34f6961f8ca458aae2369a73640dda6234c629b98bcc4`.
Its existing bundled-library and public-domain time-zone reasons remain in the
approved inventory. A complete candidate notice refresh is NOT RUN in this part.

## Commands and logs

The build used `nice -n 10 docker build`, local tag
`opencrane-package:p5-4-images2`, `-f infra/package/Dockerfile` and
`--build-arg SOURCE_REVISION=4bf20a6f004c635054fab291d3b84a801c26e83c`.
The [operator notes](../../../infra/package/README.robot.md#package-image-promotion)
give the saved-layer and promotion commands. Syft used
`scan docker:opencrane-package:p5-4-images2 --scope all-layers`.

Python ran `licences.test.py` twice and Node ran `preflight.test.mjs` twice.
Vitest ran only `infra/package/bootstrap.test.ts` twice and
`libs/events/test/security-rules.test.ts` once, with `--maxWorkers=2` and
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`.
These selected suites use their own NATS fixtures and need no projection database.
Runtime probes used disposable containers with no network, no writable root
filesystem, no added capabilities and no mounted settings.

Local logs and scan files are under `/tmp/p5-4-images2/`. CI is not awaited after
opening the draft PR. Source checks do not qualify a running package.
