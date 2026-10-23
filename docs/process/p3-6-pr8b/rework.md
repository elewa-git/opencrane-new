# Hosted tool isolation and cleanup checks

23 October 2026. Implementation: `43dff53ddbe48d02b3fc998535fccd01e8d3ce82`.
The initial fetch returned main at `dc820088eba469aca73e5768cb4b8822888e8764`.
The rebase completed, that commit is an ancestor, and no rebase remains in progress.
Both README conflicts kept the new main documentation and the hosted-tool notes.

## Changes

- Refuse every raw address binding, including infrastructure, Pod, service and
  Tailscale addresses. Permit only an explicitly approved Pod in the same silo.
  Combine its namespace selector with a label containing that Pod's UID. Refuse
  mismatched ownership, a terminating Pod and host networking. Reused IPs gain
  no permission. Public remote upstreams remain outside this installer.
- Remove lifecycle GET and POST rights on `pods/proxy`. Check health through an
  HTTP listener reached from the authorised gateway Pod. Check explicit proxy
  requests on both listening ports as well as the subresource permissions.
- Render admission objects before installation. Create and record each policy and
  binding separately, with its UID and random ownership label. Check every owned
  namespace and policy before deleting any of them. Keep partial creates recorded,
  including a create whose response is lost.
- Wait for hosted resize Pod deletion and zero reported quota usage. Give the
  independent count check room for a fifth Pod's CPU and memory. Keep the four
  resource-total checks separate.
- Share namespace validation, name the ingress rule before adding it, and apply
  the existing owner/fleet journey guard before fixture setup.

## Failing-first checks

Test-only commit `644314058` failed 11 of 33 checks before destination and proxy
changes. It reproduced accepted infrastructure addresses and malformed namespaces,
and the missing approved-Pod path. The corrected implementation passed all 33.

Test-only commit `1436d0d85`, with the synchronous-error adapter correction in
`9f5253bb2`, failed four of five checks against the old fixture. A replacement
namespace still caused policy deletion; a replacement policy was deleted;
partial isolated setup leaked its policy; resize returned before Pod deletion.
All five passed after the fixture changes in `17753f07d`.

The gateway health assertion in test commit `b8f5f1bbe` failed against the old
socket-only listener. The HTTP listener then passed it. The first broader live
attempt also caught an incorrect permission probe: `pods/proxy` meant a Pod named
`proxy` to `kubectl auth can-i`. The corrected probe uses `--subresource=proxy`.
Direct GET/POST endpoint refusals remain separate assertions.

## Current results

All tests and checks ran under `nice -n 10`. Changed tests used
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`; none of these
particular tests needs PostgreSQL. No root or projection suite ran.

| Check | Result |
| --- | --- |
| Maintained generator and fixture tests, final revision | PASS, 49 twice |
| Complete live hosted fixture, 06:40:10 UTC | PASS, 37 tests, 197.16 seconds |
| Complete live hosted fixture, 06:43:53 UTC | PASS, 37 tests, 194.81 seconds |
| Workspace and package typecheck | PASS |
| Strict typecheck of the new infrastructure fixtures | PASS |
| Event catalogue | PASS, 149 types agree |
| Code lint, including a final focused check | PASS, 24 existing warnings in the full run |
| Dependency checks and Knip | PASS, two existing Knip configuration hints |
| Markdown, local links, fixtures, licences and changelog | PASS |
| Full root suite | NOT RUN, as requested |
| Hosted application startup and dispatch | NOT RUN, still unavailable |

The first lint chain stopped on one missing blank line above a new heading.
After that correction, all remaining lint stages passed. The final focused code
lint also passed.

Fifteen temporary mutations in disposable source copies were each detected by the
maintained tests: namespace and port validation, silo ownership, Pod UID approval,
host-network refusal, selection of unlabelled Pods, adding a DNS exception,
allowing UDP, restoring proxy permission, namespace cleanup ownership, policy UID,
policy ownership label, quota settling, the fleet guard and failure-output privacy.
The copies were removed. No checked-out access or refusal assertion was weakened.

The live runs used newly created namespaces on secondary slot 1, claimed through
`infra/dev-stack/claim.sh`. The pinned computer image was
`sha256:40e715076ce0c19f0610b0fbe7872112c971d50a444487126f4465b3d8d4c3f0`.
Both runs checked the current admission templates, approved image parameters,
resize refusal, resource caps and lifecycle permissions. Each denied socket
connected after removing its directional policy, then failed after restoration.
This included node ports 6443 and 10250, the Kubernetes service, unlabelled Pods,
another silo and metadata. Metadata had a reachable control in both runs.
Withdrawal of the approved upstream binding also removed access.

The listener is a fixture, not an admitted MCP application. Namespace policy cannot
isolate a Pod from its own trusted node administrator. No application health path
uses that exemption. TCP-only rules and absence of DNS allowances are checked in
the maintained generated-policy tests; no live UDP/DNS request is claimed.

Cleanup completed in both runs. `down.sh --id 1` released the claim, and the owner
file was absent afterwards. The owner stack, host networking and Docker daemon
settings were untouched. No new image, dependency or paid model call was used.
Local logs are in `/tmp/p3-6-pr8b-checks/`. The PR remains a draft; CI is not awaited.
