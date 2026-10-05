# P4-7 shared assistant backend evidence

Date: 5 October 2026. Branch: `work/p4-7-shared-assistant`. Rebased by stashing,
rebasing on `origin/main` at `cfbf50a`, and applying the stash. Resolved the
ownership conflict with #156's fence-based `activeMember` and `currentMembership`
read. #153 and #158 had no overlapping code conflicts. No owner or secondary dev
stack was touched. Disposable test services ran locally. No paid model calls ran.

## Result and limits

**PARTIAL** for P4-7. This backend slice creates team-kind assistants with
group ownership and explicit grants; the existing assistant lifecycle claims
one computer. It adds authorised selection/detail, requester-owned private
sessions, fixed payer admission, requester-bound threads, distinct turn tokens,
and denial of cross-requester reads, resumes and swapped tokens. Commands append
once to one stream, projections rebuild from events, and the existing budget
actor handles integer euro cents.

The current MCP admission requires `accountMode: none`. This change does not add
personal credential profile selection, issuance, injection or revocation. The
recording gateway proves distinct live tokens and requester/thread refusal, but
does not prove two real requester profiles. Actual pinned Codex/gVisor context
isolation and fresh-install qualification are **NOT RUN**. The designed admin
and member screens are outside this backend change and are **NOT RUN**. Memory
remains disabled pending #97. These gaps mean the full P4-7 capability is not
complete.

## Behaviour checked

- Same-command assistant creation returns its receipt; changed and racing
  commands refuse without claiming another computer. Another assistant id is
  the explicit path to another computer.
- Replay restores `acts_for` and selected resource grants. It does not restore
  a revoked grant; assistant and group grants with equal ids stay distinct.
- A member cannot read or resume another member's session, including through
  an accidental participant tuple. WebSocket transcript delivery refuses it.
- A thread already bound to another requester or conversation is refused.
  Concurrent member sessions use separate tokens; swapped tokens and requester
  claims refuse before reaching the recording gateway.
- Shared sessions require membership in the owning and paying groups. The payer
  is fixed at conversation creation and retained on retry; personal work uses
  the configured installation default.
- Current requester, assistant, conversation and group authority is checked
  through a shared deadline. Computer generation, grants, approvals and budget
  checks remain on the existing gateway path.

## Checks

All CPU-heavy checks used `nice -n 10`. Test commands used
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres` and two workers.

| Check | Result | Evidence |
| --- | --- | --- |
| `npm run lint` | PASS | All lint stages passed; six max-lines warnings, no errors |
| `npm run typecheck` | PASS | All workspaces |
| `npm run check:events` | PASS | 89 registry/catalogue event types agree |
| Focused changed suites | PARTIAL, reruns PASS | 5 files passed; approvals and gateway had load-sensitive failures; each isolated retry passed |
| Full root suite | PASS | Started at integer load 9; 105 files passed, 4 skipped; 1,619 tests passed, 15 skipped |
| Two real requester profiles at MCP upstream | NOT RUN | Base admission only supports `accountMode: none` |
| Pinned Codex/gVisor, screens and fresh-install journey | NOT RUN | Requires the remaining capability and UI qualification |

The focused batch had one approval expectation return 503 instead of 403 and a
JetStream heartbeat timeout in the gateway suite. The refusal case passed when
rerun alone. The gateway suite passed alone with 80 passed and 1 skipped. The
full root suite then passed. No deadline or authority check was relaxed.

See the [HTTP interface and recovery semantics](../api/shared-assistants.md).
