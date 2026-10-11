# Signed hosted MCP images and changed-tool review

Design for [#47](https://github.com/elewa-git/opencrane-new/issues/47) and [#48](https://github.com/elewa-git/opencrane-new/issues/48), 10 October 2026. Base: `work/p3-6-design`, equal to local `origin/main` at `8ba1d6081452`. Proposal only; tests and journeys: NOT RUN. Only this note was written. No repository changes, stacks, tests, model calls or spending; network reads were GitHub-only.

## Existing contracts and gaps

Read #45/#46/#50/#51, their designs, AGENTS.md, the relevant plan/spec sections, all six ADRs, and the current governed tool, upload, storage and image-policy paths. Design source: `/home/jente/dev/design-handoffs/v2/01-int/README.md`, its HTML frames and admission/comparison PNGs. The old application name and example versions in these frames are stale; build screens in `apps/web` and display actual evidence. ADR 0003's October updates supersede its earlier stateless-MCP blocker.

The current implementation provides these useful parts:

- `integrations/registration.ts`, `install-worker.ts`, `remote.ts`, `inventory.ts` under `apps/server/src`: remote registration, guarded quarantine discovery, bounded pagination, exact tool definitions and `lossless-json-v1` digests.
- `libs/projections/src/tool-policy.ts`: discovered tools start Block; drift clears publication and reviews. `mcp-catalogue.ts` rebuilds the register from events.
- `libs/models/src/mcp.ts`, `decision.ts`, `gateway.ts`, `approvals.ts`: live rights, strict calls, single-use bound approvals, header stripping and dispatch evidence.
- `apps/server/src/chat/turn-tools.ts` and `apps/computer/src/mcp-proxy.ts`: only reviewed definitions reach Codex; the private proxy binds a call to its live thread. Calls use `/mcp/<serverId>/<connectionId>` and protocol `2026-07-28`.
- `files/scanner.ts`, `files/storage.ts` and `infra/clamav`: explicit clean verdicts, dated pinned scanner assets and short-lived bucket-scoped object-store leases.
- `apps/computer/check-licences.py`, `collect-licences.py`, reviewed inventories, and `infra/dev-stack/computer-admission.mjs`: exact notice review and digest-pinned Kubernetes admission. These are reusable rules, not an existing hosted-image gate.

\#45's register/detail and add/access screens have merged. Its issue history still
names publication, grants and connection gaps. On this base, publication is a simple
boolean event, gateway MCP routes are supplied at startup, and there is no general
hosted installer, revision watch or configuration acknowledgement.
\#46 supplies real proxy waiting/recovery; it currently offers credential-free,
explicitly zero-cost tools in supported personal memory-free turns.
Complete #45's reviewed publication and grant contracts before exposing hosted calls.
Do not invent replacement grants or present a publication append as Ready.

## 1. Image admission: what signed and scanned means

Accept `registry/repository@sha256:<64 hex digits>`, never a mutable tag alone. A catalogue may display a version label, but registration stores the exact digest. Default to a single selected platform manifest; if accepting an OCI index later, verify its signature and every selected child digest, and record platform selection. Check hashes of the manifest, configuration and every fetched layer. Resolve neither an update tag nor a different architecture silently during a restart.

Verify publisher signatures with [Cosign](https://github.com/sigstore/cosign/blob/main/LICENSE) (Apache-2.0). Use an operator-configured public key and repository scope, not a key supplied by the installer or image. Verify the signature's subject digest and signer. Keep publisher private keys in the publisher's signing secret store; the silo has public trust material only. Our fixture's signing key stays in the build secret store. Pin trust-set version/key fingerprint in evidence. Rotation/revocation invalidates admission until the exact digest is checked against current trust. Default to key-based verification with supplied verification material; no public identity or Rekor service is required. Do not disable signature checks to accommodate an unavailable service. Unsigned, wrong-publisher, tampered and malformed inputs stop before scans or execution.

After verification, fetch bytes into a bounded, isolated scan job. Never start the candidate to inspect it. Use existing Syft 1.54.0 and the licence gate's rules for SBOM generation, installed notices, package versions, notice hashes and completeness. Supply image-specific reviewed notices; do not apply the computer image's exceptions or trust a publisher's self-declared licence. Unknown, absent, changed or forbidden licences fail without an admin override. Application packages/binaries must be OSI; Debian main is allowed for the OS layer under AGENTS.md. Record each permitted bundled free notice with its reason. Source-available, Debian contrib/non-free and UnRAR fail.

Use [Grype](https://github.com/anchore/grype/blob/main/LICENSE) (Apache-2.0) against the generated SBOM for OS and application dependencies. Scan packages in shipped layers as well as the merged filesystem; deleted files can remain in an image layer. Reject any Critical/High finding. Show lower-severity findings with dated evidence. An unreadable package inventory, unknown severity requiring assessment, absent/stale database, timeout or partial scan cannot count as a pass. Pin tool and database versions/digests; disable automatic database replacement inside the running job. [Syft](https://github.com/anchore/syft/blob/main/LICENSE) is also Apache-2.0. Check exact pinned binaries, bundled dependencies and runtime inventories before implementation.

Malware scanning is a separate check over regular-file bytes in every shipped layer, including executables, scripts and archives, and the merged filesystem. Validate archive paths, whiteouts, links and compression before extraction: no path escape, following external links, device files, candidate execution or unbounded expansion. Count bytes/files and record coverage. Encrypted/unsupported archives, scan-limit responses, skipped content and anything without explicit complete clean evidence fail.

In development, reuse `scanFile()` and the existing ClamAV path. Retain the OC1 source commit `10abd0ef6` and AGPL-3.0-or-later notice when adapting its code. ClamAV's GPL-2.0 with linking exception is OSI; keep the reviewed image with UnRAR removed from all layers. Current clamd limits are 21M per file/stream, 80M expanded scan, 2,000 files and depth 16. They cannot establish whole-image coverage. Propose a separate pinned image-scan config with 256 MiB file/stream limit, 512 MiB archive expansion, 50,000 files and depth 16; limit the job to 2 GiB compressed, 4 GiB total expanded content and ten minutes. Keep upload limits unchanged. Send bounded files to the adapter, never one huge image Buffer. Any exceeded limit rejects the image; qualify these limits before using them.

Owner decision, 10 October: production malware checks come from our own shared scanner service in Phase 5. Do not install a scanner in every customer silo or substitute a commercial scanner. The shared service receives only image bytes/digests, not customer files, credentials or turn content. Authenticate requests/results and bind each result to the request, silo and image digest. Keep a narrow check/result contract using the same evidence fields as the dev job. Until that production service exists and is qualified, production hosted admission is unavailable; dev success does not qualify it.

Each receipt records digest/platform, request id, tool/engine version, database digest and date, checkedAt/expiresAt, coverage/limits, counts, licence-review version, signer fingerprint, policy version and hashed report references. Default scan and database maximum age: 24 hours. Check actual database age, not the time it was repackaged. Fresh receipts cannot make old definitions current. Recheck before each start and publication; refuse calls when required evidence expires. Scanner outages reject new admission; already running instances stay usable only until their existing evidence expires. Queueing is Checking/Waiting, never pass. No undated or caller-authored verdict.

Keep large reports/SBOMs in a private, silo-scoped evidence bucket using the existing S3-compatible client and short-lived lease pattern. Events retain verdicts and hashes; objects hold evidence bytes, never business authority. Authorise report reads, check hashes, and fail review if evidence is missing. Do not reuse conversation-file grants or emit `file.uploaded` for image reports. Give scan scratch its own cleanup policy. Registry reads, redirects and blob destinations use reviewed HTTPS allowlists and address pinning; reject arbitrary registries, metadata hosts and credential redirects.

Only current Owner/Admin may register, request rechecks, review, publish or remove. Require the existing OpenFGA silo `admin` relation plus current membership event facts and applied IAM receipts. Registration appends `mcp.server_registered`; it grants nobody use. `grant.given`/`grant.revoked` separately project existing `resource#use` relations for people, assistants and team members. A call needs current requester AND assistant rights. Installation, company account ownership and successful scans confer no rights. Do slow reads/checks first, then the existing two-second `authorityFence` for writes. Watch only relevant small access/policy streams; never read chat history inside it.

## 2. Running and reaching a hosted MCP

Run one credential-free instance per installed server in `<silo>-mcp`, outside gateway and computer. Use the existing worker runtime for reconciliation, not another workflow platform. The lifecycle worker has namespace-scoped create/read/update/delete rights for its own workload types; MCP processes have no Kubernetes, NATS or storage credentials. Bind deterministic workload names to silo/server/install generation and check Kubernetes UID/owner identity before mutation. Labels alone cannot prove ownership.

Require gVisor, non-root, read-only root filesystem, no privilege escalation, dropped capabilities, RuntimeDefault seccomp, no host namespaces, hostPath, device access, service-account token mount, arbitrary init/ephemeral containers or persistent volume. Use bounded memory-backed scratch. Default request: 100m CPU/256 MiB; limit: 1 CPU/512 MiB, 64 MiB scratch and 256 PIDs where the cluster runtime enforces it. Namespace quotas bound total instances; unsupported hardening must fail deployment rather than downgrade. Reuse the existing CEL admission approach in a distinct MCP namespace policy. Only the lifecycle identity can admit an exact approved digest/spec. Protect policy parameters from that identity and from MCP Pods. Admission compares all containers, mounts, identity, limits and network settings; a user label or a digest-looking string is insufficient.

NetworkPolicy defaults to deny. Inbound MCP requests come only from the named gateway workload; a discovery identity uses that same path with a short-lived discovery-only capability. Permit only `server/discover` and paginated `tools/list` in quarantine. No `tools/call`, handshake/session, batch or resource requests there. Health checks must not expose a second general entry point. Egress allows only the declared upstream's address/port and controlled DNS if required, never Internet-wide 443 or cluster-wide CIDRs. Standard NetworkPolicy cannot enforce a hostname: default to fixed reviewed IP/Pod selectors; changing DNS requires guarded resolution and replacing allowed IPs before use. A private in-silo upstream needs an explicit operator binding, not a blanket SSRF exception. Disallow metadata, control-plane and other silo destinations.

Code reaches MCP through the existing path:

`Codex → private mcp-proxy → agentgateway → ext_authz → checked hosted dispatch → MCP`

The checked dispatch step runs in the existing server/worker deployment and routes to an exact instance UID/generation. It hosts no MCP process. Its internal access identity is separate from computer/turn tokens; NetworkPolicy permits this trusted gateway transport, not arbitrary server traffic. No public Service/Ingress reaches the MCP. Gateway config, CEL allowlist, header allowlist and decision binding derive from one reviewed revision. Require acknowledged config digest, admitted image, fresh catalogue and ready instance before admitting calls. Preserve strict body/header checks and strip caller tokens/headers. Neither a caller-selected URL/Pod nor an old Service alias chooses the backend. Keep the zero-cost-only rule; charged tools need the separate budget work.

\#47 initially supports credential-free packages. Keep account mode and profile references
in contracts, but no lasting secret in environment, arguments, Pod spec or filesystem.
\#49 owns per-call credential leases; #50 adds OAuth state/PKCE, scoped discovery profiles
and generation-safe refresh. Do not add OAuth or a company fallback in this work.
\#51 extends instance identity to silo/user/profile/server/startup access generation and wakes
on demand, stops after five idle minutes and fences the old generation before rotation.
It must mount only renewable short-lived memory-held material. Reject lasting startup
secrets now. Do not reserve idle per-user Pods or add unused autoscaling infrastructure.

## 3. Catalogue capture, drift and the last dispatch check

Capture `server/discover` and every `tools/list` page at install and on EVERY process start, even for the same digest. Keep the instance out of the callable route until capture succeeds. Use existing bounds: ten pages, 100 tools/page, 32 KiB/tool, 512 KiB definition total, 900 KiB inventory and a 30-second whole discovery deadline. Preserve invalid-tool reasons and hashes; reject duplicate names and incomplete pages.

Reuse exact canonical definition digests from `inventory.ts`: name, input/output schemas, description, title, annotations, icons and metadata all participate. Description-only changes must hold the server. Stable object-key ordering and tool-name sorting prevent ordering-only drift; preserve array order and number spelling under `lossless-json-v1`. Keep before/after snapshots and rejected declarations; compare additions, removals, schema changes and description/metadata changes separately for the reviewer.

Freshness expires at checkedAt plus the shortest advertised discovery/list TTL, capped at five minutes; missing TTL is invalid, zero TTL requires checking before every use. Use the earliest page expiry. Schedule checks before expiry, with one bounded check per instance and a bounded retry deadline. Expiry denies by time even if a timer/job is down. Failed checks record failure and keep calls paused; restart never restores Ready from old projection data. An unchanged successful check may clear a freshness pause, but never a drift pause or an unacknowledged publication. It does not re-enable old approvals.

On any definition change, close the dispatch gate first, then conditionally append `mcp.tools_changed` with both digests and snapshot references. Keep it closed if append fails. ext_authz reads current event facts and freshness; generated config removes callable routes. Route removal is defence in depth, not the immediate enforcement. Keep grants as facts but unusable. Changed/new tools default Block; unchanged tools keep review choices for the next review, yet the entire server remains paused. Removed tools cannot be called. Only an explicit review and acknowledged publication restore service.

Bind permits and approvals to reviewed catalogue/policy revision, image digest where hosted, instance generation, connection/profile generation, tool revision and argument digest, in addition to existing requester/conversation/turn/assistant bindings. Cancel old pending approvals on drift and on generation changes, including unchanged names. Late Approve and previously consumed permits cannot regain access. An unchanged watch must not advance the approval's policy revision: today's comparison of ANY MCP stream position would cancel approvals on every new freshness event. Separate stable reviewed policyRevision from the latest stream position used for concurrent writes.

A watch plus ext_authz alone cannot provide “no call reaches changed tools”. The final checked dispatch consumes a short-lived, single-use internal permit and verifies the current revision, instance generation, freshness and policy immediately before sending. Serialise dispatch admission with local hold/start/publication changes. Outstanding permits cannot outlive evidence expiry or be redirected to a replacement instance. If the check needs discovery, do it before the short authority-check window; then run current authorisation again. No network discovery may occupy the two-second fence.

There is also a remote-server limit: `tools/list` followed by `tools/call` is not atomic. A mutable third-party endpoint can change between them. For the literal guarantee, default to hosted packages with a reviewed, immutable per-start catalogue and atomic revision-aware dispatch, or remote servers that atomically reject an expected-revision mismatch. Keep that revision precondition in a reviewed transport header, without rewriting the approved JSON body. Unsupported mutable endpoints stay unavailable under this strict policy; polling cannot honestly certify them. A static wrapper alone cannot force arbitrary code to obey this contract. Qualify the real hosted/remote fixture's implementation of it. Behaviour changes with identical declarations remain outside catalogue detection; signatures and isolation reduce that separate risk.

Existing calls already dispatched may finish or remain uncertain; never resend them. Reload tools only for the affected Codex conversation using its existing confirmed unload/resume path; drop its old proxy catalogue. Fail that turn if unload cannot be confirmed. Other conversations remain usable; their stale permits still fail at dispatch.

Treat descriptions and schema examples as untrusted text, including those from a signed image. Render escaped plain text, show exact before/after content and explicit injection warnings, and never load declared icon URLs or execute Markdown/HTML. Admission cannot prove a description safe. A reviewer must approve the exact definition digest before it reaches Codex. Hints suggest modes but cannot approve them. Keep descriptions inside the tool definition, never promote them to system instructions. Do not call a model to judge descriptions. Gateway rights, bounds and approvals remain necessary after review.

## 4. Commands, events, status and recovery

Proposed additions below are contracts to implement in BOTH `libs/events` and `docs/architecture/events.md`; they are not existing event types. Use `mcp-<server>` for the catalogue/install lifecycle. Each command validates current rights/state, matches command id and payload, and does ONE conditional append there. Grant and approval commands append to their existing separate streams; no multi-stream transaction. Slow external work is a reaction, never inside an install command.

| Command/fact | Recorded result and reaction |
| --- | --- |
| Register hosted | Extend `mcp.server_registered` with pinned image, upstream, platform and install id; queues checks. |
| Request recheck | New `mcp.image_check_requested` names one attempt; closes expired admission and queues checks. |
| Finish image checks | New `mcp.image_checked` holds per-check verdicts/dated receipts; only all-pass can request a start. Failed verdicts also project rejection reasons. |
| Request start | New `mcp.instance_start_requested` assigns a new generation; reaction creates the owned quarantined workload. |
| Observe start | New `mcp.instance_observed` records UID/generation and starting, running, failed or absent facts; running alone grants no access. |
| Capture/check tools | Extend first `mcp.server_discovered`; new `mcp.catalogue_checked` records unchanged fresh evidence or a failed check. Changes use extended `mcp.tools_changed` with immutable snapshots. |
| Review tools | New `mcp.server_reviewed` binds exact catalogue, image and tool choices; existing `mcp.tool_mode_set` stays revision-scoped. New tools remain Block. |
| Publish/unpublish | Extend existing events with policy/config generation, digest and original change reference. A publish is intent; unpublish immediately denies. |
| Observe config | New `mcp.configuration_observed` records acknowledged digest/generation or failed outcome; delayed acknowledgements cannot restore an older revision. |
| Remove | Unpublish with removal intent, deny first, then delete only matching owned UID/generation. New `mcp.server_removed` records confirmed cleanup; history/evidence/grants remain inert. |

Separate image admission, deployment, catalogue freshness, review/publication and account status in TypeScript projections. Checking, queued, rejected, admitted, starting, pending review, publishing, paused, Ready, removing and Removed are derived from these facts. Ready needs all required facts, matching generations and unexpired evidence. Preserve separate Installed, Connected, Allowed for and Available to the assistant cards. An unknown operation outcome is distinct from unavailable evidence and catalogue drift. No SQL business rules; PostgreSQL rows and OpenFGA tuples rebuild from events.

Use the existing ordered handler queues. Effects have deterministic attempt/workload identities; before retrying, reconcile recorded receipts and actual Kubernetes objects. A lost shared-scanner reply checks the same request. Dev ClamAV has no status API: reuse a stored hashed receipt or repeat only the unfinished live read-only scan attempt. A lost apply/delete reply checks exact UID/spec/resourceVersion. Never delete a coincidentally named foreign workload. Retry only incomplete authorised intent, with bounded attempts and dead-letter visibility. Pure projection replay neither deploys, scans nor forwards calls. Live reconciliation may resume unfinished intent after replay; old results do not become fresh checks. Missing evidence leaves admission/review unavailable until a new explicit check result.

Retain `chg_`/command id, expected position and request digest across lost HTTP/append replies. The status GET reconstructs THAT operation, not the latest server state alone. Use event-history deduplication beyond NATS's duplicate window. A 404 alone cannot prove a delayed original command will never append. “Not applied” needs definitive refusal or an operation deadline enforced by its command/reaction; otherwise retain Unknown. Only confirmed not-applied work permits a fresh attempt. The gateway never retries a possibly dispatched call. Keep existing `tool.dispatch_recorded`, approval cancellation and effect uncertainty; configuration reconciliation must not reactivate a consumed call.

## 5. Screens and APIs, including phone layout

All routes below begin `/api/org/integrations`. E = existing; P = proposed. Every mutation checks session, organisation, Origin/CSRF and current Owner/Admin. Commands carry commandId/expectedSequence; responses include serverId/changeRef.

| Frames | API binding and behaviour |
| --- | --- |
| INT-10 | E `POST /` currently registers remote only; P hosted body names image/platform/upstream binding. Disable catalogue unless reviewed entries really exist. |
| INT-11, INT-13, INT-19-RM | P `GET /:id/admission` reports each dated check and queued time. No candidate discovery starts before image checks pass, despite the frame's concurrent illustration. Save draft/leave retains the reference. |
| INT-12 | Same admission GET: all checks passed, discovery captured; Continue goes to existing tools review. State plainly that nobody gained access. |
| INT-14 | Admission GET signature refusal: digest shown; no other checks ran. Choose another signed version. |
| INT-15, INT-16 | Admission GET unknown/forbidden licence; P `POST /:id/licence-evidence` attaches a bounded reviewed evidence reference, never an override. Re-run the gate. |
| INT-17 | Admission GET Critical/High counts/time; P `GET /:id/evidence/:hash` supplies authorised findings. Also provide a malware-refusal variant with safe reason and no unsafe preview. |
| INT-18, INT-19 | P `POST /:id/checks` starts a dated attempt only after stale/definitive failed result. Queue/service outage is never admitted. |
| INT-30–37 | E `GET/POST /:id/tools`; P review/publish endpoints under #45's contract bind exact revision and audience. Show Applying until configuration acknowledgement. |
| INT-40, INT-41 | P `GET /:id/changes` returns paused reason, before/after snapshots, field changes, preserved choices and dates. New/changed tools Block. No rollback. |
| INT-42 | P `POST /:id/catalogue-checks`, then GET status. Failed watch means “No fresh check; calls paused”, not proof the upstream stayed unchanged. |
| INT-43, INT-44 | Review/publish plus P `GET /changes/:commandId`: restored only after matching config and fresh evidence; old approvals ended, people ask again. |
| INT-50–52 | P `GET /:id/removal-review`, then #45 unpublish/remove command and status GET. Unknown cleanup keeps access disabled; never removes upstream accounts. |
| INT-90–96 | Definitive no-change allows retry; conflict requires re-review. Revocation clears protected DOM and ignores late replies. Unknown offers only original-reference status GET. OAuth scopes/secret recovery in INT-91/92 belongs to #49/#50, not an invented token form. |

At 390px, replace the rail with the existing 44px menu button; use a full-screen review with Back, stacked check rows, and Before/After/Access labels on EACH comparison row. Wrap digests/names/schema text; no horizontal page scroll. Full-width primary actions, 44px targets, explicit modal confirmation, trapped focus and return focus on close. Announce each check/result once politely. Keep Continue labelled while disabled. Use static rings under reduced motion; glyphs plus words carry status without colour.

## 6. Ordered, independently landable PRs

Land serially from updated main, at most two stacked. #45 publication/grant gaps are prerequisites, not silently declared complete here. All server work precedes screens. Each row is a bounded capability with failing-first tests written before implementation. Budgets include tests, event catalogue, README/robot updates and branch release notes; if a row exceeds 600, narrow its scope before building. Original issue budgets omit these admission/recovery gaps; this estimate does not promise those old totals.

| Order / issue / maximum lines | Outcome | Failing-first proof |
| --- | --- | --- |
| 1 / #48 / 550 | Replayable catalogue snapshots, freshness and stable policyRevision; retain legacy records as unavailable without new evidence. | Description/input/output changes detected; reorder ignored; unchanged checks preserve waiting approval; replay keeps expiry. |
| 2 / #48 / 590 | Final dispatch permit, generation checks and revision preconditions; unsupported mutable servers denied. | Change between authz and send, expired evidence, permit reuse, cross-silo/backend substitution reach no fixture call. |
| 3 / #48 / 550 | Bounded watch, durable drift holds, approval cancellation and acknowledged restoration using #45 publication. | Change during pending approval/config reload; late ack, failed append/watch and worker restart never restore old authority. |
| 4 / #47 / 500 | Hosted registration/check commands, receipt/status projection and hashed evidence storage. No deployment yet. | Non-admin, tag-only, wrong digest, command reuse with altered payload, lost reply and projection replay. |
| 5 / #47 / 580 | Publisher verification plus image-specific SBOM/licence gate reuse. No unscanned deployment. | Unsigned/wrong key/tampered layer; missing notice, unknown licence, forbidden bundled bytes and wrong platform fail. |
| 6 / #47 / 570 | Safe bounded extraction and complete dev ClamAV image scanning. | EICAR in later/deleted layer and archive; escape/link, encrypted/skipped/oversized file, daemon outage and stale definitions fail. |
| 7 / #47 / 500 | Grype, dated combined receipts and production shared-scanner result contract. | High/Critical, absent/stale DB, partial coverage, forged/foreign receipt; no production service means unavailable. |
| 8 / #47 / 590 | Quarantined workload lifecycle, MCP namespace admission/RBAC/network limits. | Real disposable cluster: altered digest/spec, direct computer ingress, arbitrary egress, privilege escape and foreign workload deletion refused. |
| 9 / #47 / 560 | Capture on every start; connect checked hosted transport to existing review/publish/grant path. | Signed clean fixture → review → acknowledged publish → granted call; restart drift/ungranted/old generation calls fail. |
| 10 / #47 / 480 | Durable removal and reconciliation after lost Kubernetes replies. | Disable before delete; crash each step, UID replacement and replay produce no duplicate deployment, scan authority or call. |
| 11 / #47 / 580 | Package admission screens INT-10–19/RM using real contracts. | Keyboard, 390px/desktop/reduced motion; every refusal, queued result and disabled Continue; no fabricated pass. |
| 12 / #47 / 500 | Applying/removal and original-change recovery INT-34–37/50–52/90–96. | Lost reply/reload never resubmits; stale edit and revoked-role late reply purge protected content. |
| 13 / #48 / 570 | Paused/comparison/restored screens INT-40–44 and recovery reuse. | Description diff, stacked phone labels, Block defaults, no Ready before ack, old approval cancellation and access-loss purge. |

Earlier PRs refuse unfinished paths; later PRs enable them only through completed checks. For implementation, run required lint/typecheck/test/check:events and web checks under `nice -n 10`, respecting live-view batch exclusion. Fresh-install cluster journeys must prove admission, grants, real egress denial, drift and recovery. Scripted model replies suffice for deterministic tests; paid-provider qualification is separate and NOT RUN here.

## 7. Open questions and recommended defaults

| Question | Recommended default |
| --- | --- |
| Literal guarantee for mutable remote tools? | Require atomic revision preconditions or immutable per-start hosted catalogues. Unsupported endpoints remain unavailable; owner must explicitly choose any weaker guarantee. |
| Multiple dispatch replicas and holds? | One fenced active dispatcher per installed instance, using existing lease patterns. Signed internal permits bind request/revision/UID/expiry; replacement dispatcher starts closed and rereads events. A process-local mutex alone is insufficient. |
| Scan ages/size/resource limits? | Use the numeric defaults above, qualify on the fixture, then adjust through a reviewed policy. No UI exception or claim that upload ClamAV already covers images. |
| Trust provisioning and private registries? | Operator-reviewed public-key/repository list. No installer-added trust or lasting registry credential in MCP Pods. Reject unsupported registries until short-lived pull custody is supplied. |
| Missing production scanner? | Keep production admission unavailable until our Phase 5 shared service is qualified. Dev uses existing ClamAV; do not build a competing production scanner here. |
| External costs? | Existing box, cluster, dev object store and open-source tools by default: no new paid service. **COST OUTSIDE BOX:** hosted registry/storage/egress, shared production-scanner compute, external KMS/signing custody or paid model qualification require separate budget; none is authorised by this design. |
| Scanner metadata inside a silo? | Review exact shipped binaries/dependencies and database/signature notices. Existing operational signature data is distinct from build-only SPDX/caniuse/MDN data; do not ship the latter in silo runtime images. |
