# Saved recall preparation

5 November 2026. Part of #97. First split of PR 4m3, within the requested size limit.

Base: `34da39127b23e26e2457b57c68957769efc303fa`, the merge of #870.
Prerequisite #871 merged at `6031183ebb29f8023edf914adb04913a58088884`.
Implementation: `245b66f7a3a3b76dbcbf531c31882126fc5e69e2`.
Failing-first test commit: `484eba6ee`. The new preparation test failed because the
server entry point did not exist. The worktree ran its own `npm ci` and uses symlinks
to the shared NATS and link-checker executables. No dependency was added.

## Scope

The server helper reads saved admission and policy, then uses
`preparePersonalMemoryTools` for recall only. Deployment qualification comes from the
existing protected-file reader. Strict pending and loaded receipts bind the local
registration, returned thread, generations, expiry and load id. Each preparation consumes one completion
attempt before waiting, including when it fails. The bridge must own that preparation
and prevent replacement or resend after a lost reply.

The helper repeats access and saved identity checks after discovery. It returns a
local catalogue only. Its request contains definitions and binding metadata, with no
caller credential or RAM approval. It reads no facts, releases no private input and
issues no credentials. History is read before the two-second access check.

## Own checks

Environment: this worktree and disposable NATS/OpenFGA fixtures, with simulated
qualification measurements. This is not a fresh installation.

- PASS: failing-first regression, with the expected missing-entry-point failure.
- PASS: 96 preparation tests twice on the final implementation, 460 unchanged event-security
  tests, and 73 qualification-reader/collector tests. The checks cover real saved turn and
  policy reads, exact receipts, expiry, removal/demotion, grant/policy withdrawal, lost
  qualification, caller cancellation, Stop, closure, replacement and unrelated activity.
- PASS: `check:events` (158 event types) and `lint:changelog`.
- PASS: full typecheck and the qualification scripts’ separate typecheck.
- PASS: focused ESLint for both changed TypeScript files and the changed test file.
- PARTIAL: full repository lint is running when this receipt is recorded. Its final
  result and GitHub CI on the pushed head are reported in the draft PR.
- NOT RUN: full root suite, development stack, paid calls and live qualification.

The test file also received behaviour-preserving naming and import cleanup.
Its filesystem factory uses the same named-function style as the other test factories. Earlier setup failures came from a process mock surviving cleanup and independently
sampled catalogue timestamps. Both fixtures were repaired without weakening assertions.

Commands used `nice -n 10`. Vitest used one worker and no file parallelism, with
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`. These selected tests
need no PostgreSQL database and started their own disposable NATS/OpenFGA services.
Safe local logs are `/tmp/p4-15-pr4m3-final1.log`, `final2.log`, `tests3.log`,
`qualification.log`, `lint.log` and `typecheck.log`, each with the same prefix.

## Remaining work

PARTIAL: the server/computer exchange is not connected to live bridge dispatch.
The next split must bind preparation to authenticated turn delivery, cancel abandoned
loads, and require completion before releasing input or credentials. It must drive the
production loader, proxy, gateway and real recall backend with a scripted native peer.
It must compare the structured result and prove saved loaded evidence before bytes,
including denied and unknown evidence appends, the existing four-call/64 KiB/32-reference
limits, header replacement, two same-user catalogues, and the full discovery race matrix.
This helper's local caller registration is not wire authentication or saved memory evidence.
4n still needs that server completion. Admission remains disabled.
