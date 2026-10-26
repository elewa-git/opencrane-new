# Packaged company acceptance checklist

This is the source checklist for P5-13 PR 1, Part of #15. It preserves
[P4-28](../../specs/phase-4/tickets.md#p4-28--qualify-the-complete-company-product-on-fresh-installs)
and every [Phase 4 refusal row](../../specs/phase-4/spec.md#testing-decisions).
The executable condition and subcondition lists are `companyConditions` and
`companyRequirements` in [the catalogue](../../../infra/package/company-conditions.ts).
Every id needs executed evidence at both 1280 and 390 on each of two fresh installs.

| Inherited row | Checker conditions |
| --- | --- |
| Membership and ownership | `groups.*`, `membership.refusals`, `ownership.*` |
| Human chat and lifecycle | `direct_chat.exchange_and_no_agent`, `group_chat.exchange_and_no_agent`, `chat.*` |
| Shared assistant and child | `shared_assistant.*`, `child.creation`, `child.navigation` |
| Child disclosure and publish | `child.disclosure`, `child.publish` |
| Delegation and money | `delegation.money`, `delegation.refusals` |
| Memory rights and quality | `memory.tools`, `memory.refusals`, `memory.isolation` |
| Memory persistence and deletion | `memory.deletion`, `replay.zero_effects`, `gates.inherited` |
| No memory on disk | `memory.no_disk`, `memory.isolation`, `recovery` |
| Dreaming | `dreaming`, `dreaming.refusals` |
| Admin/onboarding | `onboarding`, `admin.refusals`, `providers.*`, `ownership.*` |
| Routines | `routines`, `routines.refusals`, `replay.zero_effects`, `recovery` |
| Regressions | `regressions.phase2`, `regressions.phase3`, `recovery` |

`participants` requires two ordinary people, two groups with distinct facts,
a child-only invitee, an admin and a second silo. `screens.accessibility` requires
all screen states and accessibility comparisons. `gates.inherited` keeps the full
P5-11/P5-12/P4-28 live gates. Existing browser ids are retained where they apply;
a Stage A/B report cannot replace packaged evidence.

## Input and result

The private JSON manifest contains `journey`, the unchanged `package-journey.json`
object from P5-11, and two `runs` in the same order. Each run contains
`fresh: {kind: "fresh-install", state: ...}` with the original pre-chat snapshot
from `fresh-twice.ts`, and `artifacts`, relative filenames. P5-11's final receipt
does not retain that snapshot. An absent snapshot remains an explicit blocker.
A restored snapshot cannot establish freshness.

Each artefact has `kind: "company-journey"`, the exact journey `binding`, `width`,
ISO `date`, safe `command` and `assertions`. Each assertion has the checklist `id`,
`status`, `executed`, non-empty `expected` and `observed` results. It also has
`results: [{requirement, evidence}]`: one reference for every subcondition in
`companyRequirements[id]`. `evidence` is a relative filename. The fixed list includes
individual daily/weekly and DST results, each inherited feature receipt, each screen
state and each native memory location for personal and group canaries at execution,
kill/resume and replay. A broad assertion cannot complete these checks on its own.

A referenced JSON file has `kind: "company-results"`, the exact journey `binding`,
`width`, ISO `date`, safe `command` and a `results` array. Each result records `id`,
`requirement`, `status`, `executed`, non-empty `expected` and `observed`, the required
`zero` counters, and `links` to non-empty supporting files. A link can name a capture,
native execution log, comparison or dependency receipt. All paths are relative to
the manifest folder. Files may hold several separately recorded results. A unique
executed PASS for the exact id and requirement is required. Wrong install/width,
pre-install dates, missing/duplicate results and absent supporting files cannot
complete that subcondition. The result lists the missing subcondition by name.

Only a unique, executed assertion and all its linked results complete a condition.
Existing NOT PROVEN and PAID / NOT RUN rows
remain untested. Real captures and focused service/native evidence must support
the recorded claims; the checker cannot authenticate a fabricated observation.

Counted `zero` fields are required: human chat uses `model`, `tool`, `wake`,
`approval`, `reservation`, `turn`; deletion/replay/recovery use `model`, `tool`,
`routine`; refusal sets, child disclosure/publication and last-owner refusal use
`upstream`. Memory checks use `persistentCanary`, `foreignCanary` and
`groupWriteApproval` respectively. Both the assertion and each linked result
need the counters.
Missing counters do not mean zero.

The checker reads at most 64 summary artefacts per install, 512 result references
per assertion and 2,048 results per result file. Each result links at most 128
supporting files. Summary, result and supporting files share a 1 MiB per-file
limit and an 8 MiB total limit, plus a manifest of at most 1 MiB. Repeated references
to a result file read it once per install; refused files are remembered too.
It refuses absolute, escaping or symlink
paths and non-files. Source, image, context, namespace/release, install time/id,
PV/PVC and store bindings must match. Identities cannot be reused between installs.
The source revision and Deployment-checked image remain separate claims; this
does not prove that the image was built from that revision.

Bindings are checked separately for each install. A refused binding names the
mismatched field without printing supplied values. Reused identities cause a
separate shared blocker. A rejected fresh snapshot leaves all dependent conditions
for that install NOT RUN; valid conditions from the other install remain completed.

The result lists completed conditions and exact blockers. `complete` tests only
whether the submitted records cover the list. The command writes no files and
never emits a qualification PASS, even for complete synthetic input. The result
stays PARTIAL or NOT RUN. A missing feature cannot shrink the required journey.
