# Fresh three-node placement checks

Date: 26 October 2026. Part of #15. Base: `599d4261d67362938df73cea7efdac36d3fc40f7`.
Failing-first test commit: `c4ba88b58`. Implementation is the commit containing this receipt.
Environment: Linux, Node 22.23.3, fresh worktree dependencies and shared Docker.
The required PR 4 and both memory branches were merged. The preceding personal
memory task exited successfully and released its slot before this claim.

Overall: PARTIAL. This first part adds acceptance checks and a bounded Kubernetes
collector. No fresh R3 package was installed. No live collection, product retry,
paid model call, owner-stack change or host network change was made.
The original run used the existing process-fixture helpers from #693/#694.

| Check | Result | Observed result |
| --- | --- | --- |
| Dependency install and local tools | PASS | `npm ci` completed; both requested tool links resolve. npm reported seven high advisories; no image vulnerability clearance is claimed. |
| Claim and capacity | PASS | `claim.sh` returned slot 1. About 10.5 GiB memory and 172 GiB disk were available. No target was created after the installer refused R3. |
| Current installer preflight | NOT RUN | The same reviewed R1 values passed; adding the three-peer settings returned `Unsupported package setting`. R3 installation cannot proceed. |
| Bootstrap and current-source images | NOT RUN | Bootstrap still calls `ensureStream({ replicas: 1 })`. The reviewed package digest below was built on 18 October and has no source revision label. R3 runtime wiring and image promotion remain missing. |
| Existing image licence review | PASS | The existing inventory check passed. No dependency or runtime image changed. |
| Private registry preflight | FAIL | A single bounded HTTP request to its existing loopback port was reset: curl exit 56. No repair or retry followed. This is an environment prerequisite failure; the underlying reset cause is undiagnosed. The request used the existing registry endpoint and did not run the new collector. Target-to-registry access remains NOT RUN. |
| Runtime and controller prerequisites | PARTIAL | Helm, kubectl, k3d and runsc exist. The existing cluster reports its sandbox controller Ready. RuntimeClass, controller, storage and image pulls on the isolated target remain NOT RUN. |
| Failing-first checks | PASS | The committed test failed before the checker module existed. The initial implementation then exposed a missing Service metadata field in the synthetic fixture; that run remains FAIL and the fixture was corrected. |
| Changed tests twice | PASS | All 29 cases passed in both final runs. |
| Required source checks | PASS | Full lint, typecheck, 154-event catalogue, Knip, changelog and 438 security rules passed. |
| Live placement and bootstrap | NOT RUN | No namespace, Helm release, Kubernetes node/peer/PVC identities, R3 leader or current replicas were collected. Source fixtures do not qualify Kubernetes behaviour. |
| Live service proofs | NOT RUN | Conditional append, stale-position refusal, replay, route TLS refusals and non-writer publication refusal require the blocked fresh install. |
| Inherited owner and chat journeys | NOT RUN | Verified-owner sign-in and core stub chat at 1280/390 were not run. No new captures exist to inspect or publish. |
| Private exposure journey | NOT RUN | No packaged services/listeners or outside-tailnet refusal were tested. The registry preflight is not an exposure qualification. |
| Owned cleanup | PASS | Normal `down.sh --id 1` removed the claimed directory. All Docker container IDs and existing namespace UIDs matched before and after cleanup; slot 2 stayed free. No target or package remained to remove. |
| Rotation, node loss/rejoin and real zones | NOT RUN | Outside this placement/bootstrap task. |
| Full root suite | NOT RUN | Explicitly excluded from this run. |

The reviewed server/web image is
`k3d-ocn-registry:5000/opencrane/package@sha256:0a92219795920c6ebf4fd054b2331a69b6538a30a2d30c723591e4c8c25ef15a`.
The NATS image is
`k3d-ocn-registry:5000/opencrane/nats@sha256:301a9c3b2784494116e94ad6ad108e2b20fd9655c4e3d4b59106b031f5c59ef3`.
Neither pin establishes a fresh R3 installation from this source.

The collector reads only a recorded isolated target and checked package. It checks
Kubernetes observations against original fresh-state and stream-info files supplied
by the operator. It does not collect those files or prove their origin. It saves
selected identifiers only, never raw Pod settings or Secret data. Its tests cover
refusal without an isolated target; successful live collection remains NOT RUN.

The next part needs supported R3 bootstrap/runtime wiring, reviewed images from
that source, working private registry access and isolated-target prerequisites.
It must then collect the original fresh-state and JetStream reads, run the real
service refusals, repeat browser/exposure checks, inspect captures and clean up.
No guard was relaxed to advance past a missing prerequisite.

[Check summaries](checks.txt) retain the original source-check failures too.

## Source repairs on 26 October 2026

Rebased onto `690c2e44c`; the rebase completed with that commit as an ancestor.
Source: the implementation commit containing this update. Environment: the same
Linux host and Node 22.23.3. These checks use temporary files and command fixtures.
No development stack was claimed or started, and no live collection was attempted.

The checker now requires the container's writable claim mount at `/data`, its
explicit store setting and its reviewed startup configuration. It reads only the
selected `cluster.conf` ConfigMap key and `nats.conf` Secret key for comparison;
it never saves those contents. Missing mounts, hidden store paths, different
configuration and command overrides refuse. The summary records the store path.

The checker also requires unlimited message, byte and per-subject counts (`-1`)
and no age expiry (`0`). All four values appear in the summary. Limits of one
message or one second refuse.

Collector and inherited ownership commands pass the private connection filename
through the child environment's `KUBECONFIG` setting. A process fixture checks the
actual spawned arguments and environment. Bounded reads cover supplied placement
files, target/package/stack ownership, image review and reviewed configuration.
They read at most 1 MiB plus one detection byte and refuse larger input before
parsing. Growth tests append after the size check for each ownership/input file.

The failing-first commits are `cc79c9b0b` and `a0dc79ddd`. An initial test-harness
run lacked a dependency link, and later runs exposed an inactive growth hook and
a relative-path mismatch. Those were setup/test failures and were corrected;
only the corrected regression runs count as evidence. Older package fixtures now
check the new child environment while retaining their ownership and gateway checks.
A later collector fixture run reached its existing deadline under host contention.
Its command stub now uses the shell to avoid repeated Node startup; the deadline
and assertions are unchanged. The wider package run also exposed older mocks and
route-fixture deadlines. The original failures and final results are retained in
[checks.txt](checks.txt).

Live placement, bootstrap, service refusals, browser journeys and private exposure
remain NOT RUN. The earlier HTTP reset is an environment prerequisite failure;
its cause remains undiagnosed. This repair does not change those blockers.

| Repair check | Result | Observed result |
| --- | --- | --- |
| Placement, collector and fresh-install fixtures twice | PASS | 90/90 in each final run, including all six growing-file cases and spawned-argument checks. |
| Ownership and cleanup fixtures twice | PASS | 38/38 in each run; ordinary R1 forwarding and target-loss refusal remain covered. |
| Chart fixtures twice | PASS | 12/12 in each corrected run; exact gateway and replacement-namespace assertions remain. |
| Route preparation fixtures twice | PASS | 19/19 in each final run, including the earlier deadline cases. |
| CNPG installation fixtures | PASS | All 126 cases passed in the wider package run. That combined run still records its five other fixture failures. |
| Workspace and infrastructure typechecks | PASS | Full typecheck and the final package typecheck passed. |
| Event catalogue, Knip and changelog | PASS | 154 event types agree; both separate lint commands passed. |
| Docs and public-text privacy | PASS | Corrected Markdown and privacy checks passed. |
| Full lint | PASS | Code, dependency direction, unused code, docs, README rules, links, fixtures, image licences and changelog passed. Code lint reported zero errors and 25 existing size warnings. |
| Full root suite and live qualification | NOT RUN | Explicitly excluded; no development stack was claimed or started. |
