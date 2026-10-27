# Candidate package inventory

Date: 27 October 2026. Part of #15. Overall: PARTIAL.

This is the first part of the inventory and notice refresh. Detailed bundled
licence declarations and acceptance reasons need a separate change to stay within
about 600 non-generated changed lines. They remain blocked. This receipt records local checks
only. Approved images, inventory, index pins and licence rules are unchanged.

## Candidate bytes

The image was built from an extracted Git archive of committed source
`0ba702c6e3ed062e7ff812875f9de873d41da4b3`, using the unchanged Dockerfile,
`nice -n 10 docker build` and local tag `opencrane-package:p5-4-images4`.
A fresh `npm ci` and linked NATS/Lychee tools prepared this worktree.
The [candidate record](candidate.json) binds the source archive, saved image,
configuration, local index, inspection, Syft scan and shipped notice checksums.
The build source precedes the test and evidence changes; no runtime code changes here.

Syft 1.54.0 scanned every shipped layer. Its 455 components match the earlier
455-component scan: 276 npm packages, 90 Go modules, 88 Debian packages and Node.
The candidate inventory uses the exact checksum of the approved 454-entry list,
removes two old versions and adds three checked entries. The normal licence
checker compares every reconstructed component, including duplicate identities.

Saved package metadata confirms demo-mcp 0.1.0 under AGPL-3.0-or-later,
follow-redirects 1.16.1 under MIT and zod 4.6.6 under MIT. Their package and licence
files were read from the archive and have recorded checksums. The downloaded
kubectl and agentgateway bytes match the existing Dockerfile checksums.
The Node notice and Debian status bytes match the earlier image evidence.
The [notice record](notices.json) preserves all 43 Node section checksums.
Each section's declaration review is NOT RUN. Bundled parts in the Go binaries
and other packages also still need complete declaration and reason records.
No unknown declaration receives approval from an inventory match.

## Debian main

The cached snapshot is Debian bookworm at `20260713T000000Z`, from
`snapshot.debian.org/archive/debian/20260713T000000Z/dists/bookworm/`.
The checker runs `gpgv` with the pinned keyring and reads only its verified output.
It matches the exact SHA-256, size and `main/binary-amd64/Packages.xz` record in that
output. All 88 installed package/version pairs match both the signed index and scan.
The release, keyring and index checksums are in the candidate record.
This authenticates the existing snapshot again; no fresh index download is claimed.

## Own checks

Tests were committed first in `0dc7563b8` and `0254715c3`. Five cases failed before
the checker and records existed. Another required every pending Node section to
keep its checksum and status. The final fixtures also test required
notice and signed-index files. Builds, tests and source gates use nice priority; Vitest
uses the supplied `PG_TEST_URL` and starts no projection database.

| Check | Result | Observation |
| --- | --- | --- |
| Licence fixtures, twice | PASS | 27 cases per run; old inventory, extra older-layer package, missing entry, altered version/source/digest, missing notice and unsupported declaration refuse. |
| Preflight fixtures, twice | PASS | Existing promotion and licence fixtures pass. No source-bound R3 approval is supplied. |
| Candidate evidence, twice | PASS | All 455 entries compare; saved image/configuration/index/source and scan checksums agree. |
| Signed-index tampering | PASS | Altered signed release, index bytes and installed version each refuse. The valid chain passes. |
| Required evidence removal | PASS | Missing Node notice, signed release or scan entry refuses. |
| Archive and import checks, twice | PASS | All nine pass; deleted files remain absent from every layer and synthetic owner setup completes. |
| Event security rules | PASS | All 460 cases pass. Protected security and authority tests are unchanged. |
| Lint, typecheck, events, Knip and changelog | PASS | Requested source gates pass. |
| Approved inventory against candidate | FAIL | It still refuses three extra and two missing entries, as required. |
| Candidate promotion | FAIL | Existing checks refuse missing source-bound R3 evidence. |
| Complete bundled licence approval | NOT RUN | Separate declaration review remains required; the notice record is PARTIAL. |
| Publication, vulnerability clearance, live install and fresh R3 | NOT RUN | Outside this part. |
| Full root suite | NOT RUN | Excluded by the task. |

The first local index parser did not accept Debian's padded spaces; the fixture
now covers that spacing. A count moved into a helper also needed an explicit return.
Both were corrected before the repeated passing runs.
Local archives, scans and logs remain in `/tmp/p5-4-images4/`.
The [operator notes](../../../infra/package/README.robot.md#package-image-promotion)
describe the archive and promotion commands. The candidate check is
`nice -n 10 python3 docs/process/p5-4-images4/check-candidate.py /tmp/p5-4-images4`.
No dev stack, model call, registry publication or daemon/network change was made.
