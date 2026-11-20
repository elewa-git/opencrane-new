# Host preflight review fixes

Fix round 2 of 2, slice 1 of 1. Source diff:
`d52da1d372080e71bee0ea7b7656505547da72fa..700007b4d394e0ac2e7eca3e48d052a357bffc9c`.
The first commit, `809dd733b`, adds the stronger fixtures and failing reason
assertions. The second, `700007b4d`, fixes the refusals, parsing and diagram.

## Findings and reproduction

1. Bind fixture observations to the `spec.nodeName` of each submitted probe Pod.
   Supply separate invalid evidence for each local override authority check,
   keeping all other evidence valid. Keep the existing API/local UID test.
   Each isolated removal below failed exactly its named test. Restoring the
   source passed all 41 host and identity tests twice.
2. Add `HostRefusalReason`, the union `unsafe_settings | unknown_override |
   unverifiable_host`, and carry it on `HostCheckRefused`. The
   [failing-first run](logs/round-two-reasons-red.log) passed four tests and
   failed thirteen because the expected reason was absent. The assertions still
   require the existing advice and refusal messages. Removing the reason
   assignment independently fails the unknown-override test.
3. Split comment removal, row trimming, sysfs reads, Docker endpoint parsing and
   k3d prefix removal into named steps. Temporary source-structure tests failed
   on the reported chains before the edit, then passed afterwards. The host
   and identity tests passed twice after the rewrite.
4. Group computer settings with the installed apps in the package README
   diagram. Keep the host check and all calls. A temporary diagram test failed
   with nine boxes before the edit and passed with eight afterwards.

| Isolated mutation | Its failing test |
| --- | --- |
| Pin every probe to node-1 | refuse a failing second node before installation and clean its probe |
| Remove the DOCKER_HOST Unix check | override authority requires DOCKER_HOST Unix endpoint |
| Remove the Docker-context Unix check | override authority requires Docker-context Unix endpoint |
| Remove the permitted k3d-name check | override authority requires permitted k3d name |
| Remove the container-count check | override authority requires container count |
| Remove the exact container-name check | override authority requires exact container name |
| Remove the Running check | override authority requires Running container |
| Remove the cluster-label check | override authority requires cluster label |
| Remove the API/local UID comparison | a matching local container name cannot waive another cluster node |
| Remove the refusal reason assignment | unknown override values fail closed |

[Mutation summary](logs/round-two-mutations.log),
[structure tests before](logs/round-two-style-red.log) and
[after](logs/round-two-style.log). Each mutation's full failing output is retained
alongside the summary as `round-two-mutation-*.log`. These were isolated file
copies with in-memory command fixtures; they started no containers or stacks.
The production guards were never removed from the working source.

## Own checks

| Check | Verdict |
| --- | --- |
| Host settings and override identity tests | PASS twice; 41 tests per run |
| Each authority guard, node binding and reason removal | PASS; each mutation fails its own test |
| Reported parsing chains and README diagram | PASS after reproducing all three structural failures |
| Workspace, package and dev-stack typecheck | PASS; full workspace and both infrastructure packages |
| Event catalogue | PASS; 174 event types |
| Knip | PASS; two existing configuration hints |
| Changelog lint | PASS |
| Changed-file ESLint | Files ignored by repository configuration |
| Supplementary ESLint of all three changed code files | PASS; no warnings, standard size and complexity limits |
| Markdown lint | PASS, including the final receipt edits |
| Public privacy and secret scans | PASS before push |

[First host run](logs/round-two-hosts-1.log) and
[second host run](logs/round-two-hosts-2.log), and
[gate output](logs/round-two-gates.log). All local checks run under
`nice -n 10`. No full root suite runs.

## Installer behaviour and journey

Journey rerun: **NOT RUN**, as authorised for behaviour-preserving review fixes.
The named source diff changes test observations, internal typed refusal reasons,
parsing variable names and README text. It changes no acceptance decision,
operator message, probe command, host setting, install record or Helm ordering.
The existing [fresh packaged and core journeys](journey.md) remain **PASS** on
their recorded source, at 1280 px and 390 px. No new live PASS is claimed.
Production-node disk qualification remains **NOT RUN**. No stack was claimed.

## Make it right and branch state

Keep the shared host rules, safe public advice and node identity checks in their
existing modules. Add no dependency, abstraction, retry, timeout or catch.
The changed production helpers remain within the standard size, complexity,
depth and parameter limits. Document the exact reason contract in the package
robot README; keep the newcomer diagram at eight boxes.

Fetched `origin` before editing. `origin/main` remained at
`c791103b365ced8fd56195ded9d0dcfabf202597`, the branch's existing base.
No rebase was needed; no rebase is in progress. The PR stays a draft.
