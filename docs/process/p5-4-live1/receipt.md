# Fresh three-node placement checks

Date: 26 October 2026. Part of #15. Base: `599d4261d67362938df73cea7efdac36d3fc40f7`.
Failing-first test commit: `c4ba88b58`. Implementation is the commit containing this receipt.
Environment: Linux, Node 22.23.3, fresh worktree dependencies and shared Docker.
The required PR 4 and both memory branches were merged. The preceding personal
memory task exited successfully and released its slot before this claim.

Overall: PARTIAL. This first part adds acceptance checks and a bounded Kubernetes
collector. No fresh R3 package was installed. No live collection, product retry,
paid model call, owner-stack change or host network change was made.
The existing process-fixture helpers from #693/#694 remain unchanged.

| Check | Result | Observed result |
| --- | --- | --- |
| Dependency install and local tools | PASS | `npm ci` completed; both requested tool links resolve. npm reported seven high advisories; no image vulnerability clearance is claimed. |
| Claim and capacity | PASS | `claim.sh` returned slot 1. About 10.5 GiB memory and 172 GiB disk were available. No target was created after the installer refused R3. |
| Current installer preflight | NOT RUN | The same reviewed R1 values passed; adding the three-peer settings returned `Unsupported package setting`. R3 installation cannot proceed. |
| Bootstrap and current-source images | NOT RUN | Bootstrap still calls `ensureStream({ replicas: 1 })`. The reviewed package digest below was built on 18 October and has no source revision label. R3 runtime wiring and image promotion remain missing. |
| Existing image licence review | PASS | The existing inventory check passed. No dependency or runtime image changed. |
| Private registry preflight | FAIL | A single bounded HTTP request to its existing loopback port was reset: curl exit 56. No repair or retry followed. Target-to-registry access remains NOT RUN. |
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
