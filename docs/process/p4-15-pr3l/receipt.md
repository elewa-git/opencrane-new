# Personal reply state receipt

5 November 2026. Part of #97. This is the first part of P4-15 PR 3l.
Base: `6031183ebb29f8023edf914adb04913a58088884`, the merged PR 3k (#871).
The clearance schema is the strict, position-free `private_output_cleared` frame.
The [accepted delivery boundary](https://github.com/elewa-git/opencrane-new/pull/863#issuecomment-6638487509)
orders delivery at the final authority position read. This change leaves that boundary alone.

## Scope

Private frames bypass socket history and reach only the current personal session.
A reply stays in page memory, separate from saved rows and catch-up positions.
Exact clearance, access loss and session/connection changes discard it. Ordinary
messages and uploads retain it. A completed turn may retain an already received reply.
The first frame supplies the server-checked thread and input identity; history does not.

PARTIAL: the requested feature is split to keep each change around 600 changed lines.
This first part does not display private text. A later part must add safe Markdown,
cancel pending private Mermaid work, remove rendered images and accessible text,
show unavailable/restriction notices and capture six desktop/phone screenshots through
`visual:p4-15-pr3l`. It must also check starts that arrive while a subscription catches up.
The current state accepts only new starts after the socket reports ready.

## Own checks

The environment is an existing development worktree with installed dependencies,
synthetic browser fixtures and no development stack or model calls.
Failing-test commit: `b59e3127a`. The protocol test failed because a valid private reply
was rejected by the socket union, before the implementation changed.

Checks are being completed; final results will be recorded before submission.

NOT RUN: private reply rendering, diagrams, screenshots and fresh-install live qualification.
Native admission remains disabled. No authority or security test was edited.
