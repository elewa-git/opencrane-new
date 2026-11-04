# Private thread discovery contract

For people, read [README.md](README.md) first.

Part of #97. This is the first split of PR 4m, limited to session/loader compatibility.
The branch retains failing-first commit `3e06753ed`; `84a9fb5c7` adds the joined tests.
The base already includes #862 (`4df894661`) and #863 (`5e5882fed`).
Their launch and private-output contracts remain in force.

The production session allows `config/mcpServer/reload` and `thread/loaded/list`
without a threadId only when their parameter object is empty. Other requests after
startup still need the bound threadId. Another `thread/start` is refused before sending.
The loader binds the native response's ID before checking the registered caller again.
Repeating that same binding is valid; replacing an existing binding is refused.
Closing the native output rejects pending RPCs immediately. A destroyed socket need
not emit an end event; waiting for that event left discovery pending until its timeout.

The joined fixture uses the production session opener, launch authentication, loader,
caller registry, server assembler and MCP proxy. Its native peer is scripted over a
local Unix socket. Its server admission and qualification are synthetic, in one process.
No approval object or registry crosses a production wire. Discovery returns fixed
recall definitions only. No grant, model call or backend fact read occurs.

The fixture checks two sessions for the same person, cancellation during discovery,
lost reload replies, mismatched thread requests and process requests with extra fields.
Initial discovery finds no catalogue. Cleanup removes only the owning catalogue.
The existing native tests separately exercise pinned Codex discovery and recall transport.
Neither fixture qualifies deployment.

## Remaining production part

PARTIAL: the computer-side exchange is described below. The server still needs to send
it after saved admission, using `preparePersonalMemoryTools`, deployment-owned qualification
and a matching discovery receipt before releasing initial input or credentials.
RAM approvals are not wire proof. The server must repeat access, policy and qualification
checks after waits. A real backend fixture must prove loaded evidence before recalled
structured results.
Native writes, shared/team scopes and fresh-install qualification remain separate work.
Global admission, reserved paths and protected authority/security tests are unchanged.

## Own checks

2026-11-04, base `5e5882fed` plus this branch; isolated local fixtures, not a fresh silo.

- PASS: 793 distinct tests across 14 selected files, including 460 unchanged security
  tests. The final 11 joined tests passed twice. The six pinned native discovery
  cases passed after correcting normal-close handling; all 29 private-output cases
  passed after installing the missing gateway fixture with the repository pretest script.
- PASS: full typecheck, event catalogue check, changelog check and focused code lint.
- PARTIAL: full lint was still running when this receipt was written. Its final result
  and GitHub CI belong in the draft PR's evidence. The first lint run was stopped after
  prolonged execution near its default heap limit; the rerun uses a 6 GiB Node heap.
- NOT RUN: full root suite, development stack, paid calls and fresh-install qualification.

Commands used `nice -n 10`; tests used one worker and a disposable PostgreSQL database.
The database was removed with its volume after the tests. No deployment is qualified.

### Fixture structure checks — 4 November 2026

The fixture now separates proxy setup, socket startup, protocol handling, session
creation, approval preparation and cleanup into named functions. The turn request
and loader driver are named objects. Spy setup and catalogue removal use separate
statements. This is a behaviour-preserving refactor; all assertions are retained.

- PASS: 693 tests across `private-recall-preflight`, `private-session`,
  `private-thread-loads`, `thread-loads`, `thread-load-lifecycle` and the unchanged
  `security-rules` suite. The 11 `private-recall-preflight` cases also passed a
  second time.
- PASS: full typecheck, event catalogue and changelog checks.
- PASS: full lint, including Knip, dependency checks, documentation, links, fixtures
  and licences. ESLint reported zero errors and 35 existing size warnings.
  The lint command used `NODE_OPTIONS=--max-old-space-size=6144`.

The targeted tests used `PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`,
one worker and no file parallelism. All checks used `nice -n 10`.
No full root suite, development stack, model call or fresh-install qualification ran.
Production recall remains PARTIAL and admission stays disabled.

## Computer-side loading

Part 2 starts from #867 (`64586a95c`). Prerequisites are #862 (`4df894661`, private
launch ownership) and #863 (`5e5882fed`, requester-only volatile reply release).
The failing-first commit is `4b7bc0a47`. This is a further split within the 600-line limit.

A restricted personal chat carrying one recall definition uses the existing loader.
The authenticated computer bridge sends `recall_pending` after `startPrivate` returns.
It carries a random `loadId`, turn, conversation, requester, assistant, computer, silo,
returned thread, computer/input generations and original expiry. No caller credential,
registry or RAM approval is serialised. This message is volatile and is not journalled.

The server's future `recall_load` must repeat every field, replace the message type,
and add only `tools`. The computer rejects extra fields, changed identities, a changed
catalogue, non-recall tools, Ask and duplicate requests. It compares the local registration
again during `loadPrivate`, using the existing proxy controls and discovery check.
Only successful discovery returns `recall_loaded` with the original binding.
A refused load closes that session. Stop, disconnect and expiry revoke its caller.
Lost requests or replies are never resent. Two sessions of the same person stay separate.

A grant or initial input arriving before discovery ends the turn without installation.
The complete turn frame, including tools and credentials, must fit 120 KiB before the
grant is installed. Tools retain the 48 KiB limit. Restricted native notifications allow
only recall on this loaded server, alongside the existing non-tool item types.
The trusted initial-input wording permits only explicitly supplied tools.
No new event or public API is added. New message field names pass `RISKY_FIELD_NAME`.

PARTIAL: production server assembly and credential release remain unconnected. The next
part must save admission, use `preparePersonalMemoryTools` with deployment-owned
qualification, validate these messages on the server, and recheck membership, policy
and qualification after discovery before releasing input or credentials. It must prove
real structured recall results and saved loaded evidence through the backend and gateway.
The existing four-call/64 KiB/32-reference checks and bound-header replacement are unchanged;
this fixture does not exercise them. Native writes and shared/team scopes remain later work.
Admission stays disabled. Fixtures do not qualify deployment.

### Own checks for the computer exchange — 4 November 2026

Local worktree based on `64586a95c`; disposable fixtures, not a fresh silo.

- PASS: 859 distinct tests across ten selected files, including the unchanged 460
  security-rule cases. The final 36 runner/discovery tests passed twice.
- PASS: full typecheck and a final computer typecheck, event catalogue and changelog checks.
- PASS: all lint stages, including Knip, dependencies, docs, links, fixtures and licences.
  ESLint had zero errors and 35 existing size warnings. Two extra blank lines were fixed
  before repeating the documentation and remaining lint stages.
- NOT RUN: full root suite, development stack, paid calls and fresh-install qualification.

Checks used `nice -n 10`, one test worker and no file parallelism. The PostgreSQL fixture
used an assigned loopback port and was removed with its volume after the tests.
