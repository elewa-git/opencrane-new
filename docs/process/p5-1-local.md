# Local package check

17 October 2026. Source before this change: `8f10ade7` on `origin/main`.
Working branch: `work/p5-1`. Chart version: `0.1.0`. The local cluster was
`k3d-ocn`; all live work used claimed secondary slot 1. No customer silo or
hosted resource was used.

## Before and after

The new tests were copied into a clean `origin/main` snapshot and run there
before checking this worktree. The baseline preflight suite had nine failures:
there was no package preflight command, so none of the expected refusals could
be identified. The updated suite passed all nine cases. It distinguishes a
missing digest, a mutable tag, an image outside the reviewed list, a missing
secret name, public ingress, LoadBalancer, Funnel and a missing chart version.

The baseline claim tests failed in two concrete ways. After a 16 minute claim
with a dead launcher and a simulated live package namespace, a second worktree
received slot 1. A foreign `down` completed. In this worktree, the matching
tests passed: the second worktree received slot 2 and foreign cleanup was
refused. The full claim suite passed all thirteen cases, including a foreign
package record, an unrecorded Helm release and a fresh Compose startup against
a package namespace.
These are controlled Kubernetes fixtures, not a live Helm release.

## Local exercise

| Check | Result | Observation |
| --- | --- | --- |
| Chart render | PASS | `helm lint` passed. The render has five ClusterIP services and no public route. |
| Pinned website image | PASS | The final local image served HTTP 200 on a loopback Docker port. This was not a Helm smoke test. |
| Local Kubernetes image pull | PASS | A Pod in the claimed package namespace ran `node --version` from the pinned digest and completed. It was removed before slot cleanup. |
| Registry push | PARTIAL | Docker push through the published loopback port reset. A direct upload on the local Docker network published the final image by digest. |
| Package preparation | PASS | Slot 1 created only `opencrane-package-1`, UID `d0ee43b4-2add-41a9-b8dc-c85255e184a2`. |
| Missing pin | PASS | `package-up` exited 1 before Helm created a release or workload. |
| Missing named secret | PASS | A values file with all reviewed pins passed preflight. `package-up` reported `Required secret is absent: runtime` and exited 1. Helm still had no release or workload. |
| Rejected-install cleanup | PASS | `package-down` removed that namespace, then `down` released slot 1. |
| Owner stack isolation | PASS | The owner namespace UID and Compose container names matched the snapshots taken before preparation. |
| Other installs | NOT RUN | No other package install was present to compare before and after. |
| Live Helm install and core smoke | NOT RUN | Workers and owner bootstrap are not packaged yet. Required runtime secrets were not provisioned. |
| Verified owner sign-in | NOT RUN | No packaged live environment was ready. |
| Outside-tailnet probe | NOT RUN | No installed endpoint was available to probe. |
| Runtime licence inventory | NOT RUN | Deferred to part b to keep this change focused on pins, ownership and exposure. |

The final local image is pinned as
`sha256:7c42dcbb3ea1d88c01febd60bb3645d6c9fb612a46248078651a1e4f567f5c1b`.
This is a source and registry pin, not a runtime licence approval. No secret
value was placed in a values file or receipt. The package is not ready for
fresh-install acceptance.

## Source checks

| Check | Result | Observation |
| --- | --- | --- |
| `npm ci` | PASS | Clean worktree packages installed. |
| `npm run lint` | PASS | No errors; 20 existing function-length warnings remain elsewhere. |
| `npm run typecheck` | PASS | All workspaces completed. |
| `npm run check:events` | PASS | 143 event types agree. |
| Claim tests | PASS | Thirteen Node tests passed, including foreign and other-slot cleanup. |
| Package refusal tests | PASS | Nine Node tests passed. |
| Angular tests | PASS | 61 files and 1,017 tests passed. |
| Root suite | FAIL | It reported four failures in `memory-mcp.test.ts` under `nice -n 10` with a throwaway `PG_TEST_URL` database. The run was stopped after almost 50 minutes because the gate had failed. It did not finish all test files. The test database and volume were removed. |

## Cleanup checks, 18 October 2026

Source: `99686686`, rebased onto `origin/main` at `14d4dd7c`. The rebase
completed and neither rebase state directory remained. These checks used fresh
temporary home directories and command fixtures. No live stack was started or
changed. The two stacked branches were left alone.

The failing tests were committed before their fixes. Commit `88d65ff5` shows
that a later foreign or unlabelled Helm release was accepted after a saved
attempt. Both refusal tests failed as expected; the owned interrupted release
still cleaned up. Commit `06db9453` adds successful record-free teardown with
an assertion that Kubernetes was never called. Commit `32c40ca4` also checks
that recorded computers are removed without probing a Helm namespace. Both
teardown cases failed before the fix.

Cleanup now requires the saved random install ID to match the Helm release
label. It also checks any saved Secret UID. Secondary teardown skips Kubernetes
when neither a package record nor the saved computer quota exists. Started
Compose stacks still remove their computers. The quota file is saved before
computer setup contacts Kubernetes, so interrupted setup still has a cleanup
record. An unavailable recorded package keeps its record and reports failure
after Compose stops.

| Check | Result | Observation |
| --- | --- | --- |
| Changed suites, first run | PASS | 20 claim tests and 9 preflight tests; no skips. |
| Changed suites, second run | PASS | The same 29 tests passed again; no skips. |
| Lint, including Knip and changelog | PASS | `nice -n 10 npm run lint`; zero errors, 20 existing function-length warnings. |
| Workspace typecheck | PASS | `nice -n 10 npm run typecheck` completed. |
| Event catalogue | PASS | `nice -n 10 npm run check:events`; 143 types agree. |
| Full root suite | NOT RUN | Excluded from this fix round. The earlier result above is historical. |
| Live Helm install and fresh-install journey | NOT RUN | Command fixtures prove local cleanup decisions, not a live installation. |

Both test runs used `PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`
and `nice -n 10 node --experimental-strip-types --test
infra/dev-stack/claim.test.ts infra/package/preflight.test.mjs`. These suites do
not use PostgreSQL. Logs are `/tmp/p5-1-final-tests-1.log` and
`/tmp/p5-1-final-tests-2.log`; the typecheck log is
`/tmp/p5-1-final-typecheck.log`. The lint log is `/tmp/p5-1-final-lint.log`.

## 18 October 2026: packaged runtime and licence review

This follow-up used branch `work/p5-1b` and claimed secondary slot 1. The final
fresh namespace was `opencrane-package-1`, UID
`b1f7297a-5337-416d-a562-99e052e78164`. The chart and five image roles were
fixed to reviewed digests. The website and server share one application image.
Secrets were created from private files inside the claimed slot. No secret value
was put in Helm values or this receipt.

| Check | Result | Observation |
| --- | --- | --- |
| Worker and bootstrap chart tests before change | FAIL | The part a chart had no worker Deployments or owner bootstrap Job. The new render tests failed against it. |
| Worker and bootstrap chart tests after change | PASS | The render now has the member, conversation, budget and dispatcher workers and the owner bootstrap Job. |
| Fresh Helm install | PASS | The final pinned image started server, web, NATS, PostgreSQL, OpenFGA and eight workers. All Deployments reached Ready. The bootstrap Job completed on its first attempt. |
| Separate owner user | PASS | The installed projection contained `jente-rosseel`, `jente@elewa.ke`, role `owner`, status `joined`. The Job confirmed its event-backed OpenFGA owner grant. The existing Zitadel user was not changed. |
| Sign-in page and browser session | PASS | Loopback website returned HTTP 200 and sign-in redirected. A real browser signed in with the slot's separate CI user and `/auth/me` confirmed the session. |
| Stub-model chat turn | FAIL | The signed-in workspace API returned HTTP 503. This minimal chart has no chat key directory, model gateway or computer runtime, so no turn was sent or completed. |
| Outside-tailnet probe | PASS | A throwaway process on Docker's bridge network could not connect to the loopback forward on port 25106. The forward listened only on `127.0.0.1`; the chart exposed only ClusterIP services. |
| Other installs and owner stack after cleanup | PASS | Package namespace and slot claim were removed. The owner and slot 2 namespace UIDs and the existing container names and IDs matched the snapshots from before cleanup. Port 44200 still listened on loopback; the package forward on 25106 was gone. |
| Root suite | NOT RUN | This follow-up was instructed not to start the full root suite. |

The signed-in installed page was captured at
[1280px](p5-1-live/signed-in-1280.png) and
[390px](p5-1-live/signed-in-390.png). These images show the successful browser
session. The workspace did not pass the chat smoke.

### Licence inventory

Syft 1.54.0 scanned each final pinned runtime image. The application image has
275 npm packages, 90 Go modules, 88 Debian packages and one Node binary: 454
components.
The same image serves the website. PostgreSQL has 142 Debian packages and four
Go modules. The scratch NATS image has 11 Go modules and no operating-system
packages. The scratch OpenFGA image has 143 Go modules and no operating-system
packages. The exact names, versions, selected licences and evidence are in
`infra/package/licence-inventory.json`. That file also records the OSI notices
inside Node and the public-domain ICU time zone data notice with its reason.
It records the downloaded kubectl binary separately because the scanner reports
its Go modules but not the executable itself.

| Check | Result | Observation |
| --- | --- | --- |
| Application licences | PASS | Every application dependency has an OSI-approved licence. The first-party packages use the root AGPL licence. The npm package with an MIT or CC0 choice uses MIT. |
| Debian base packages | FAIL | All 88 Node image packages were found in bookworm main. Only 137 of 142 PostgreSQL image packages were found in trixie main. Five PostgreSQL packages came from PGDG, so the pinned image does not meet the Debian main rule. |
| Go modules without embedded licences | PASS | Their source licence files were checked and recorded by hash. The pinned Kubernetes and gosu sources were checked against their official Apache-2.0 notices. |
| Unknown and forbidden licence refusal | PASS | Synthetic checks refused `UNKNOWN`, BUSL and a package outside Debian main. A fresh Syft scan matched every reviewed image inventory entry. |

The image inventory check ran against the final application digest
`sha256:9789e2934c50e5fb04830036a0a6a98a7f49eaee0001edab783183db77bc9afe`.
It also checked PostgreSQL
`sha256:d74eeac9a635390a49bc21bd49fccd973de707e2a53a76ac49b552b8712ec46f`,
NATS `sha256:301a9c3b2784494116e94ad6ad108e2b20fd9655c4e3d4b59106b031f5c59ef3`
and OpenFGA
`sha256:53b782878ca260da1118ba36b6b9a7cf0cc376c4522755bafd036abed0e09796`.
The chat journey remains incomplete.

### Debian main check after review

The checker now uses a small list of exact names and versions from the signed
Debian main indexes. It checks each Debian package in every image inventory
against the list for that image's base release. Lint does not download indexes.
The checker also refuses a changed Debian-based image pin until the index list
is reviewed for the new image.
The list has 88 bookworm pairs and 137 trixie pairs. At that point, the remaining
five packages in the PostgreSQL image were absent from trixie main:
`libpq5 18.6-1.pgdg13+2`, `postgresql-17 17.11-1.pgdg13+2`,
`postgresql-client-17 17.11-1.pgdg13+2`,
`postgresql-client-common 293.pgdg13+1` and
`postgresql-common 293.pgdg13+1`. That check refused the image until the
PostgreSQL apt archive review below was added.

One HTTPS download batch used Debian's snapshot archive. The bookworm files
came from `snapshot.debian.org/archive/debian/20260713T000000Z/dists/bookworm/`;
the trixie files came from
`snapshot.debian.org/archive/debian/20260918T000000Z/dists/trixie/`.
The signed releases are dated 11 July and 12 September 2026 respectively.
`gpgv` accepted both `InRelease` signatures with the Debian archive keyring
copied from the pinned PostgreSQL image. That keyring's SHA-256 was
`506b815cbb32d9b6066b4a2aa524071e071761e7e7f68c3ac74f3061ba852017`.
The bookworm stable release signing key was
`4D64FEC119C2029067D6E791F8D2585B8783D481`; the trixie key was
`41587F7DB8C774BCCF131416762F67A0B2C39DE4`.

| Release | Signed `InRelease` SHA-256 | Extracted `Release` SHA-256 | Main `Packages.xz` SHA-256 |
| --- | --- | --- | --- |
| bookworm | `77737fa4b34f2693e982cc9ee35736816c35a7778fc2d326cc1bbf5b301fe1aa` | `abcf5882746e0f68171f41adbb4ac01b74b49d62d203379befb9265804311a4f` | `9e0b5aabb2465b3d2e7a7fe27f9913846277833f7a2826e7767acccff5b588c5` |
| trixie | `0584fba32e13e0ab8285fb16c27adea1ec03a73669c18702821094fd6ca86675` | `ed56aac47e7911e65ee63aae8d67e29f20e023f840e49f8ed037043a33de138a` | `7778d3e3f303b7ddb8ce0fe7c8d57473a076c6bf2e8f241f75421d2396352498` |

Each `Packages.xz` SHA-256 matched the SHA-256 entry in its signed `InRelease`
file. Only `main/binary-amd64/Packages.xz` supplied the reviewed list. A new
package, a different version, or a package outside main is refused until a
new signed index is checked and the list is reviewed.

| Source check after the index change | Result | Observation |
| --- | --- | --- |
| Missing package test before the fix | FAIL | A made-up package labelled `Debian-main` exited 0; the test required exit 1. |
| Changed image pin test before its fix | FAIL | A changed base image reached the PostgreSQL package failure; the test required an earlier refusal of the new pin. |
| Changed licence tests after both fixes | PASS | Ten tests passed on each of two runs. |
| Typecheck | PASS | All workspaces and the package TypeScript check completed. |
| Event catalogue | PASS | All 143 event types agreed. |
| Knip | PASS | It exited 0 with two configuration hints. |
| Changelog check | PASS | The branch fragment passed. |
| Full lint | FAIL | Earlier lint steps passed. The package licence step refused PGDG `libpq5 18.6-1.pgdg13+2` in the pinned PostgreSQL image. |
| Full root suite | NOT RUN | This round was limited to changed tests. |

### Source checks in this follow-up

| Check | Result | Observation |
| --- | --- | --- |
| `npm ci` | PASS | The worktree installed from its lockfile. |
| `npm run typecheck` | PASS | All workspaces and the package TypeScript check completed. |
| `npm run check:events` | PASS | The 143 catalogue event types agreed. |
| `npm run lint:unused` | PASS | Knip exited 0 with two configuration hints. |
| `npm run lint:changelog` | PASS | The new branch fragment passed the gather check. |
| Package render and refusal tests | PASS | Eleven Node tests passed twice, including the new worker and bootstrap render cases. |
| Licence refusal tests | PASS | Unknown, BUSL, non-main, bundled notice and manual component cases passed twice. |
| `helm lint` | PASS | The final chart rendered with reviewed pins and five named secret references. |
| `npm run lint` | PASS | The full command completed with no errors and 20 existing function-length warnings outside this change. |

### PostgreSQL apt archive review, 18 October 2026

The pinned upstream `postgres:17` image is still
`sha256:d74eeac9a635390a49bc21bd49fccd973de707e2a53a76ac49b552b8712ec46f`.
Five of its 142 Debian packages came from the PostgreSQL project's apt archive
(PGDG). The other 137 still match the signed trixie Debian main index. The
checker now requires each PGDG package's exact name, version and licence to
match [the reviewed extract](../../infra/package/pgdg-trixie-main.json). It
refuses a PGDG label for an absent package. A PGDG package labelled as Debian
main still fails the Debian check.

One HTTPS retrieval batch read the `trixie-pgdg` `InRelease` and the `main`
and `17` amd64 `Packages.gz` files from
`https://apt.postgresql.org/pub/repos/apt/dists/trixie-pgdg/`. The signed
release is dated 15 October 2026. The repository key came from
`/usr/local/share/keyrings/postgres.gpg.asc` in the pinned image. Its SHA-256
is `ab3ea5fa18220d88318cd9e41d1e4e709c9003c71494f9022cbd76353ba7c5e1`.
Its fingerprint is `B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8`.
`gpgv` reported a good `InRelease` signature from that key. The signed
`InRelease` SHA-256 is
`97fbcf24b43ff386ea077b1a4887199e4edbb5de38ee5a9fd1ab30a7d03dfb09`;
the extracted `Release` SHA-256 is
`10ffe4b0b5abc256f7174a346e5bc9bc0073b5e9f6d100927b0d77e0ef2c4628`.
The downloaded `main/binary-amd64/Packages.gz` SHA-256 is
`a3f950abbc70349df9319027bda0cf963a10e22535f6492b984e8ef1f7fc1965`.
The downloaded `17/binary-amd64/Packages.gz` SHA-256 is
`96cc182eeecbfaff9284c2a783febd9c06f55c054ddcc5077e7c550dafdb9c54`.
Both hashes matched the SHA-256 entries in the signed Release. All five
installed versions were present in the `main` index. The `17` index was not
needed for the extract.

The five package copyright files in that same image were checked separately.
`libpq5`, `postgresql-17` and `postgresql-client-17` name the PostgreSQL
License. Their copyright file SHA-256 is
`afcc052a946b4117667527211b4ca303f07044f5585222f4c8f577e0764b2123`.
`postgresql-common` and `postgresql-client-common` name GPL version 2 or
later. Their copyright file SHA-256 is
`292dcc67fc22ad11156da2b7a154da74b65e63e0f673f3d301a5ed6df85327fe`.
The extract also records each package archive checksum from the signed index.
No new image or dependency was added.

The new refusal tests were committed before the checker change. Before it,
the 13 licence tests had two failures: the PGDG case reported a
five-field format error, and the unchanged real inventory was refused at
`libpq5`. The Debian-main-labelled PGDG package already failed as required.
No Helm install or live stack was started for this fix.

| Check in this fix round | Result | Observation |
| --- | --- | --- |
| Rebase onto `origin/work/p5-1` at `ac8dbc7a` | PASS | The rebase finished, and that base is an ancestor of this branch. |
| PGDG package and real inventory tests | PASS | All 13 licence tests passed twice. The checked inventory has 454 server, 454 web, 146 PostgreSQL, 11 NATS and 143 OpenFGA components. |
| Changed slot and package tests | PASS | All 31 tests passed twice with `PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres` and `nice -n 10`. |
| Typecheck | PASS | The first run found an optional Helm Secret UID assignment in the rebase conflict resolution. After that was fixed, the full workspace and package typecheck passed. |
| Event catalogue | PASS | All 143 event types agreed. |
| Knip | PASS | The `lint:unused` stage of full lint exited 0 with two configuration hints. |
| Changelog check | PASS | The branch fragment passed. |
| Full lint | PASS | The first run found a missing blank line in this receipt. After the spacing fix, full lint passed, including package licences. ESLint reported 20 existing warnings and no errors. |
| Full root suite | NOT RUN | This fix round ran the changed tests only. |
| Live Helm install | NOT RUN | The pinned image and review data did not need a new install for this source fix. |

Logs: `/tmp/p5-1b-changed-tests-final-1.log`,
`/tmp/p5-1b-changed-tests-final-2.log`,
`/tmp/p5-1b-licence-tests-final-1.log`,
`/tmp/p5-1b-licence-tests-final-2.log`,
`/tmp/p5-1b-typecheck-2.log`, `/tmp/p5-1b-events.log`,
`/tmp/p5-1b-changelog.log` and `/tmp/p5-1b-lint-2.log`.

## 18 October 2026: local chat turn

This follow-up used branch `work/p5-1c` and claimed secondary slot 1. The final
fresh namespace was `opencrane-package-1`, UID
`146c87ae-4a0d-4873-8972-8e7100167327`. The final application image was
published and installed at
`sha256:0a92219795920c6ebf4fd054b2331a69b6538a30a2d30c723591e4c8c25ef15a`.
Its model gateway used only the local stub. A fresh wrapping key was generated in
the claimed slot and passed to both chat processes through a Kubernetes Secret.
The package's private volume held only wrapped conversation keys. Sign-in and
model files also came from the claimed slot as Kubernetes secrets. No secret
value was written to this receipt or to Helm values.

| Check | Result | Observation |
| --- | --- | --- |
| Failing-first chart check | FAIL | The previous chart had no chat key volume, model process or computer template. The new render test failed before these were added. |
| First browser attempt | FAIL | Sign-in passed, but `/api/chat` returned HTTP 403 because the separate test owner's sign-in subject was not linked to the event-backed owner member. |
| Final install | PASS | PostgreSQL, NATS, OpenFGA, web, server and eight workers reached Ready. The bootstrap Job created the joined owner and its OpenFGA grant. The model process and computer template ran in the same claimed namespace. |
| Browser chat, 1280px | PASS | A signed-in owner sent “Say hello briefly.” The browser showed “Hello from your computer.” and Done. [Screenshot](p5-1-live/chat-1280.png). |
| Browser chat, 390px | PASS | The same browser journey completed at mobile width. [Screenshot](p5-1-live/chat-390.png). |
| Stub-only model calls | PASS | The local stub counted exactly two model requests after the two browser turns. The package checks that its upstream is the local stub before Helm applies resources. |
| Chat key custody | PASS | The runtime Kubernetes Secret held a generated 32-byte wrapping key. Both chat processes used it. Two new key files on the private volume were 60-byte encrypted records. A wrong wrapping key failed the focused test. |
| Private network | PASS | All five services were ClusterIP. There was no Ingress. A throwaway process on Docker's bridge could not reach the loopback-only forward on port 25106. |
| Image licences | PASS | A fresh Syft scan matched all 454 reviewed application components. The added agentgateway binary has a checksum and Apache-2.0 review. The pinned computer image points to its existing 385-component licence review, checked by hash. The other image reviews still passed. |
| Cleanup and isolation | PASS | Cleanup removed the computer claim before the warm pool, then removed the namespace and released slot 1. The owner namespace UIDs, every existing container name and ID, and loopback listener on 44200 matched the snapshots taken before installation. The package forward on 25106 was gone. Another worktree added slot 2 containers during this check; this install did not touch them. |
| Existing person's own Zitadel login | NOT RUN | The available browser credential belongs to a separate Dev test owner linked to the `jente@elewa.ke` member. No credential path was available for the existing person's Zitadel account. That account was not changed. |

The chart includes the same pinned computer image already reviewed in
`apps/computer/licences.json`. The package's image inventory checks that file's
digest and the computer image digest before installation. The final signed-in
pages were also captured at [1280px](p5-1-live/signed-in-1280.png) and
[390px](p5-1-live/signed-in-390.png).

### Final local checks

| Check | Result | Observation |
| --- | --- | --- |
| Key and chat tests | PASS | Two runs each passed 10 focused tests, including wrapped key storage, decryption with the same Secret, refusal with another Secret, and existing chat commands. |
| Package chart and licence tests | PASS | Two runs each passed three chart tests and seven licence refusal tests. A fresh Syft scan of the final image matched all 454 reviewed application components. |
| Package ownership and cleanup tests | PASS | Two runs each passed eight cases that check ownership, interrupted installs, safe cleanup and Kubernetes failures. |
| Full claim test file after live cleanup | PARTIAL | Several fixture cases expected slot 2 to be free. Another worktree had started that slot, so these failed at setup. The full file passed twice before the wrapping-key change, which did not alter claim behaviour. |
| Event catalogue, Knip and changelog | PASS | `check:events` checked 143 events; `lint:unused` and `lint:changelog` exited 0. |
| Typecheck | PASS | `npm run typecheck` completed for all workspaces and the package TypeScript project. |
| Lint | PASS | `npm run lint` completed with no errors. ESLint reported 20 existing function-length warnings outside this change. |
| Full root suite | NOT RUN | This follow-up was instructed not to run it. |

## 18 October 2026: private computer network and key files

This fix round rebased only this branch's two earlier commits onto
`origin/work/p5-1b` at `74b84388`. The rebase finished and that parent is an
ancestor of this branch. I claimed secondary slot 1 with `claim.sh`. The
final fresh namespace was `opencrane-package-1`, UID
`b1300b25-e1b0-49d2-b8f0-3c621de6390d`. The application and computer image
digests did not change. The model still used the local stub.

The new chart test first failed on the DNS allowance and missing file mount.
A later test first failed when the bootstrap Job did not mount the file Secret.
Another first failed on the workers' old certificate paths. The final mode
test first failed because it needed a private copy of the mounted files.
Each test was committed before its fix.

| Live check | Result | Observation |
| --- | --- | --- |
| First install attempt | FAIL | The bootstrap Job could not read its NATS files because its file Secret was not mounted. That namespace was removed. |
| Second install attempt | FAIL | Bootstrap completed, but the workers still used old NATS file paths. That namespace was removed. |
| Final fresh install | PASS | Bootstrap completed and all eleven Deployments reached Ready in a newly prepared namespace. |
| Computer network | PASS | The live policy permits one egress rule: TCP 43000 to the server Pod. It permits no port 53. The computer ConfigMap contained `http://10.43.70.32:43000`, the live server Service ClusterIP. |
| Wrapping key files | PASS | The text runtime Secret had no key file entry. The separate file Secret held a fresh 32-byte key. The server key and worker NATS file were owned by user 1000 with actual mode 0400. Application mounts were read-only. A test key containing a NUL byte survived `kubectl` Secret rendering. No key value was logged. |
| Browser chat at 1280px | PASS | The signed-in test owner sent “Say hello briefly.” The stub reply and Done appeared. [Capture](p5-1-live/chat-1280.png). |
| Browser chat at 390px | PASS | The same turn completed at mobile width. [Capture](p5-1-live/chat-390.png). |
| Licence check | PASS | All 88 server Debian name/version pairs matched the reviewed Bookworm main list. The digest-bound server and web review matched the current image, and the computer kept its separate 385-component inventory check. |
| Cleanup | PASS | The package namespace and forward were removed, slot 1 reported free, and both owner namespace UIDs and all pre-existing container names and IDs matched the earlier snapshot. |
| Existing person's own Zitadel login | NOT RUN | The browser used the separate development test owner. |
| Full root suite | NOT RUN | This fix round was instructed to run changed tests only. |

The final signed-in pages were also captured at
[1280px](p5-1-live/signed-in-1280.png) and
[390px](p5-1-live/signed-in-390.png). No Secret value was put in Helm values,
this receipt or the captures.

### Final source checks

| Check | Result | Observation |
| --- | --- | --- |
| Changed Node tests | PASS | The 34 claim, chart and package preflight tests passed twice with `nice -n 10` and the supplied `PG_TEST_URL`. |
| Licence tests | PASS | All 14 Python tests passed twice. `check:package-licences` accepted all six pinned image roles. |
| Wrapped key tests | PASS | The two tests passed twice with a throwaway PostgreSQL container and `PG_TEST_URL`; the container and volume were removed. |
| Typecheck | PASS | All workspaces and the package TypeScript project completed. |
| Event catalogue | PASS | All 143 event types agreed. |
| Knip | PASS | The command exited 0 with two configuration hints. |
| Changelog check | PASS | The branch fragment passed. |
| Full lint | PASS | The command completed, including package licences. ESLint reported 20 existing warnings and no errors. |

## 18 October 2026: rebase onto main

This check rebased the eight package chat commits onto `origin/main` at
`e3467aa2c`. Git skipped five older licence and package commits because their
changes were already on main through the earlier package merge. The completed
rebase has no unresolved files. The diff from main contains the chat runtime,
key files, private computer network, package checks, documentation and captures.
The server and dev-stack README diagrams keep the newer main text and the chat
key and gateway details. Both diagrams still have at most eight nodes.

| Source check | Result | Observation |
| --- | --- | --- |
| Full lint | PASS | `nice -n 10 npm run lint` completed, including the exact image licence checks. |
| Typecheck | PASS | Every workspace and the package TypeScript project completed. |
| Event catalogue | PASS | All 145 event types agree. |
| Knip and changelog | PASS | Both separate commands exited 0. |
| Package and dev-stack Node tests | PASS | Two runs passed all 47 cases each, including the preflight checks. |
| Package licence tests | PASS | Two runs passed all 14 cases each. |
| Wrapping-key tests | PASS | Two runs passed both cases each with `PG_TEST_URL` set. |
| Full root suite | PARTIAL | A two-worker run reported two gateway test failures, then was stopped after 45 minutes without a full summary. It had a throwaway PostgreSQL database through `PG_TEST_URL`; the container and volume were removed. |
| Isolated gateway cases | PASS | The two reported failures passed alone: five matching cases passed in 21 seconds. |

The partial root log is `/tmp/p5-1c-root-suite.log`. It reports a current-claim
readiness timeout and an Astra daily-cap case. Neither is counted as a passing
full-suite run. That root run used main before its later chat cleanup commit.
The focused Node, licence and wrapping-key tests passed twice again after the
final rebase. The passing focused logs are under `/tmp/p5-1c-final-`.

### 19 October 2026: fresh package on main

This run used main commit `81263fd7` and claimed secondary slot 1. The fresh
namespace was `opencrane-package-1`, UID
`c9c0e50c-710c-46de-aee1-6225be63fccc`. The existing Zitadel management
token was passed by file path. The package used its own generated wrapping key
and local model stub. No external model key was needed. The sign-in account was
the separate OpenCrane 2 Dev CI owner linked to the `jente@elewa.ke` member.
The existing person's Zitadel account and the owner stack were not changed.

| Live check | Result | Observation |
| --- | --- | --- |
| Slot ownership | PASS | `claim.sh` selected slot 1; package preparation created only its owned namespace. |
| Private secret preparation | PASS | The separate development sign-in app and test users were ready. Six named Kubernetes Secrets were created from files in the claimed slot. |
| Fresh Helm install | PASS | Helm revision 1 deployed. The bootstrap Job completed, and all eleven Deployments reached Ready, including the server with its model gateway and the web app. A computer Pod ran for the turns. |
| Browser chat at 1280px | PASS | The signed-in test owner sent “Say hello briefly.” The reply “Hello from your computer.” and Done were visible in the [capture](p5-1-live/chat-1280.png). |
| Browser chat at 390px | PASS | A new turn showed the same reply and Done in the [capture](p5-1-live/chat-390.png). By eye, the message, reply and composer did not overlap. |
| Model and key custody | PASS | The local stub counted exactly two model requests. The private conversation key directory held two 60-byte wrapped records; no key contents were read or printed. |
| Cleanup and owner isolation | PASS | `package-down` removed the namespace, then `down.sh` released slot 1. The slot reported free, port 25106 closed, both owner namespace UIDs and all pre-existing container IDs remained, and owner port 44200 still listened on loopback. |

The signed-in pages were also refreshed at
[1280px](p5-1-live/signed-in-1280.png) and
[390px](p5-1-live/signed-in-390.png). These captures and the two chat captures
come from this main install.

## P5-2: two fresh installs

On 19 October 2026, the corrected runner attempted one pair on secondary slot 1.
`infra/dev-stack/claim.sh` returned `1` after `df -h /` showed 94 GiB free.
The runner received `ZITADEL_KEY_FILE` as a path. Provider preparation stayed
read-only. The owner stack was not changed.

**Overall: FAIL.** The first install passed the fresh-data and provider/owner
checks, then failed during browser capture. The runner stopped and cleaned up
that install. The second install was **NOT RUN**. This attempt does not qualify
two fresh installs or successful owner sign-in. The earlier passing pair does
not replace this corrected-runner result.

The first namespace UID was `5f8db8dd-7f47-4943-bdb6-0e4e1d6a4cf3`.
Its Helm install id was `e70cd52f-210d-432b-aa4e-235c0638c524` and its release
Secret UID was `890e2af9-05be-4640-9b43-eb4e7273f7d8`.
The observer retained PVC UIDs `0e9eba4e-b2a1-413e-8979-ee6b52bfe259` and
`29bbafc6-efc4-4738-84c9-ea073ed4151a`. It overwrote its earlier observations
during cleanup, so the other PVC UIDs and OpenFGA store id were not retained.
No second-install ids exist for this attempt.

| Check | Fresh 1 | Fresh 2 |
| --- | --- | --- |
| Claim, install and fresh data | PASS — owned claim and release, new PVCs and events, only the bootstrap owner, no conversation, file or rows in any of the five memory tables before chat | NOT RUN |
| Provider and owner binding | PASS — trusted issuer, slot test subject, verified provider email, invitation and join events, joined owner row and OpenFGA owner check | NOT RUN |
| Browser sign-in and stub chat at 1280/390 | FAIL — browser capture failed before producing a new capture; the runner did not retain the browser substep | NOT RUN |
| Screen review | NOT RUN — no new captures | NOT RUN |
| Exposure | PASS — the runner checked ClusterIP Services and no public ingress; the forward listened on `127.0.0.1:25106`; a container on Docker's default bridge could not reach the host gateway on that port | NOT RUN |
| Owned cleanup | PASS — namespace, package owner record, forward and namespace PV claims were removed; slot 1 was released | NOT RUN |
| Owner and other-slot resource comparison | NOT RUN — no comparison in this attempt | NOT RUN |
| Object storage | NOT RUN — outside this chart | NOT RUN |
| Person's own Zitadel login | NOT RUN — the separate slot test owner was used | NOT RUN |

The eight `fresh-1-` and `fresh-2-` PNG files in
[p5-1-live](p5-1-live/) are from the earlier pair. They are historical evidence,
not captures from this attempt. The disk still had 94 GiB free after cleanup.
Browser launch and import of the sign-in helper passed as separate diagnostics;
neither diagnostic proves sign-in.

The fixture suite now tests the runner with fake external commands. Each of
five otherwise-valid refusal fixtures changes just one thing: the stack owner,
the package record, the namespace UID, namespace existence, or a claimed PV.
Namespace preparation is represented by local fixture files. The fake Helm and
kubectl commands record later writes. Every refusal checks its exact reason and
records zero such writes; a valid start reaches both fake commands.
The issuer and subject fixtures keep their identity rows, events and browser
subject consistent while leaving trusted expectations unchanged.

**Single-check removal probes: PASS.** All 34 refusal tests failed under their
matching individual removal in a disposable copy. Each removal restored the
source before the next probe. No whole function was removed. Removing the
shared `checkStart()` call failed all four start-refusal tests. Removing the
first `verifyPackageOwner()` call in the runner failed only the UID-change test.
The two positive controls passed. The 36 probe logs are
`/tmp/p5-2-guard-*.log`; the complete test-to-removal list is in the PR comment.

The failing-first test commits precede the memory-check implementation.
The first corrected test run failed on the four untested memory tables and the
missing runner export. The final changed tests passed twice, 38 tests each,
with `PG_TEST_URL` set and `nice -n 10`. These Node tests use normal disposable
fixtures and do not use PostgreSQL or start a live package.

| Source check | Result |
| --- | --- |
| Changed fresh-install and provider tests, twice | PASS — 38 tests each |
| Single-check removal probes | PASS — 36 removals; all 34 refusal tests covered |
| `npm run lint` | PASS — 21 existing warnings, no errors |
| `npm run typecheck` | PASS |
| `npm run check:events` | PASS |
| Knip and `npm run lint:changelog` | PASS |
| Full root test suite | NOT RUN — outside the requested checks |
