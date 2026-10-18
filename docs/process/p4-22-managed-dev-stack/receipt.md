# Managed calls in the local development stack

18 October 2026. Source: `0ab8165e57cd9f73c19986c011797d93edbc81e6`.
Secondary id 2 was obtained through `infra/dev-stack/claim.sh`. The owner stack was
not used. No paid provider was called.

## Source checks

PASS: test-first commit `404820f7` failed on the missing setup/environment modules
and the stub's model-list 404; the four existing stub tests passed.
PASS: all seven changed tests passed twice, including refusal at every HTTP step
and an unsuccessful verification returned with HTTP 200.
PASS: workspace typecheck, changed dev-stack file typecheck, event catalogue,
knip, changelog, code/dependency/docs/link/fixture lint, and 438 event-security tests.
All tests and checks ran under `nice -n 10`. No full root suite was run locally.
The initial lint run found a bare email address in Markdown; the remaining lint
stages passed after that was corrected.

The optional whole dev-stack typecheck reports existing errors in `wake-latency.ts`
and `zitadel-setup.test.ts`. Neither file changed. The focused typecheck passes.

## Fresh-install attempt

The first startup, at `8395285d`, stopped before provider setup because the gateway
symlink pointed outside the container mounts. Startup now copies the pinned binary
into the mounted stack directory. A second `up --fresh` used the same claimed slot.

| Check | Result |
| --- | --- |
| Shared provider folder created as the host user, mode 0700; models mount read-only | PASS |
| Stub credential file mode 0600 | PASS |
| Create provider, save credential, reachability, consented model test | PASS |
| Provider status `ready`; non-streaming reply accepted by product verification | PASS |
| Enable chat models, select explicit silo default, start drain | PASS |
| Switch on and complete `up --fresh` | PARTIAL: switch-on returned 403 |
| Managed requests before switch-on | PASS: 2 verification requests; 0 other credentials |
| Credential value and file locations absent from reached provider replies, stack logs and all 49 saved events | PASS |
| Restart models without `MODEL_KEY_FILE` after switch-on | NOT RUN |
| Later-joining member chats through the default; only managed requests after switch-on | NOT RUN |
| Twice-fresh qualification | NOT RUN; remains for PR 5e |

Saved evidence contains one `budget.call_dispatch_admitted` for
`provider-reachability` without a reservation. The existing switch-on check keeps
that send permission open. It has no completion writer, as described in
[the provider contract](../../api/providers.md#switching-on-managed-calls).
No product check was changed or bypassed. No switch-on event or chat turn was saved.
The drain stayed active, and models correctly retained its pre-switch-on setting.

## Images and gateway

| Process | Running image id |
| --- | --- |
| Models: Node 22.23.1 bookworm slim | `sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3` |
| PostgreSQL 17 | `sha256:d74eeac9a635390a49bc21bd49fccd973de707e2a53a76ac49b552b8712ec46f` |
| NATS 2.15.0 alpine | `sha256:ac8f88a6494bffc2c2a5289a0ca61cb28a9145c11ba5677cf24265d07f46d8d4` |
| OpenFGA 1.21.0 | `sha256:2113c664a486b5da8d7a2cdab479e0d4e30639c80fd2c000540f645c1dbc1e55` |
| MinIO RELEASE.2025-10-15T17-29-55Z | `sha256:cf23643a6cf9ce159c57643ceb88279e431262282428c9e0bf3a7ef1a97e84b4` |
| ClamAV 1.5.2 no-unrar | `sha256:701a670a1666ecfac079b9aa5a3716218c4c500c7f96518e1df574ca5b610ace` |

Gateway SHA-256: `daca5cda76e8c5ab0c1a75912fecf2d6365095403f810db72029c49d14a37e7b`.

Teardown: PASS. `down.sh --id 2` removed this stack's containers, both namespaces,
private directory and claim. The owner stack was not used.
