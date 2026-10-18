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
| Debian base packages | PASS | All 88 Node image and 142 PostgreSQL image package versions were found in signed Debian main package indexes. No version was missing. |
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
