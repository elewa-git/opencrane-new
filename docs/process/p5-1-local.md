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
