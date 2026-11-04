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

PARTIAL: the authenticated server/computer catalogue hand-off and runner dispatch are
not built here. They need a strict volatile preparation message after saved admission,
`preparePersonalMemoryTools`, deployment-owned qualification and a matching discovery
receipt before initial input or credentials can be released. RAM approvals are not wire
proof. The server must repeat access, policy and qualification checks after waits.
A real backend fixture must prove loaded evidence before recalled structured results.
The existing trusted without-tools wording remains accurate until that path is connected.
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
