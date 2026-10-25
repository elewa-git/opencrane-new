# P2-5 chat UI qualification

The [3 October final-round receipt](chat-final-evidence.md) records the rebased
source, owner defaults and latest stack qualification. The earlier run follows.

Date: 2 October 2026. Branch `work/chat-ui`, based on bridge merge `1138544`.
The commit containing this receipt records the source and checks.
No real OpenAI calls: the dev stack uses its loopback scripted provider.
Zitadel is restricted to organisation `393311211338337681`; access is tailnet-only.

## Evidence

| Check | Result | Evidence |
| --- | --- | --- |
| Red/green member context and durable Stop | PASS | Real NATS/PostgreSQL/OpenFGA chat HTTP tests |
| Bridge interrupt and partial report | PASS | Includes failed interruption after delayed start: no false terminal event, reconnect retains output, retry succeeds |
| Independent review | PASS | Two passes; interruption retry and stale rail summaries fixed and verified |
| Transcript replay | PASS | Completion replaces deltas; duplicate suppression; Stop freezes partial text |
| Required gates | PASS | `lint`, `typecheck`, `check:events` (74 types) and `npm test -- --maxWorkers=2`: 1,023 passed, 3 skipped; PostgreSQL URL specified in the task |
| Angular unit suite | PASS | 43 tests; `NO_COLOR=1`, zoneless render waits |
| Web production build | PASS | Initial and component size warnings; all error budgets pass |
| Chromium frames and interactions | PASS | Keyboard, focus, 44px targets, stream/Stop/reload, offline retry and wake state |
| Computer image build and qualification | PASS | `b2a2852e085fe852a61125f48258630ac284ab1090e35fcf235e9eed9b8a3994`; licence, gVisor, fresh/resumed isolation and document checks |
| Fresh dev stack | PASS | `up.sh --fresh`: real browser chat/Stop/reload, wake, disk persistence, replay, logout and listener checks |
| Plain dev stack up | PASS | `up.sh`: same browser and lifecycle journey against retained state |
| Main checkout restored fresh | PASS | Stopped this stack, restored `stack-owner` to `<worktree>`, ran its `up.sh --fresh`; checkout remains clean |

[Computer qualification receipt](chat-computer-evidence.json) records the exact
image digest. Its `source` is the base HEAD at build time; the build includes
the working-tree Stop fix committed alongside this receipt.

[Stack journey receipts](chat-stack-evidence.txt) retain the successful checks.

[Frame comparison](../design/chat/comparison/index.html) uses Playwright screenshots
and protocol fixtures, separately from live journey evidence.
[Reuse and scope](../design/chat/IMPLEMENTATION.md) explains the personal-session
adaptation and the supplied reference archive.

PARTIAL: file cards and preview UI are implemented, but the bridge has no
file-byte transport. Live originals and rendered previews remain unqualified.

NOT RUN: real OpenAI; owner's manual sign-in/visual approval; Safari/Firefox;
production installation; live file upload/preview and Office conversion through
the chat transport; group/direct sessions, approvals and rendered A2UI.

The browser path also passed in a direct diagnostic journey. Earlier wrapper
runs failed on occupied dev ports and an intermittent sign-in screen timeout;
a later diagnostic reached chat, wake, replay and disk persistence but failed
during the final logout probes. The combined journey now has a five-minute
outer deadline for browser and lifecycle checks, while per-step limits remain.
The linked final fresh/repeat receipts determine live qualification.

The three opt-in tests skipped by the root suite are the real-provider call,
standalone k3d lifecycle and standalone k3d bridge tests. The dev-stack journey
separately exercises the live lifecycle and bridge with the scripted provider.
No CI or remote PR was run; this branch is committed locally without a push.
