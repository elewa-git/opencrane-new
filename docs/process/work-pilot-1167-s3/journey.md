# Populated pilot update and rollback

Journey on a fresh dev stack: FAIL

The current source checks pass. The fresh CORE journey failed before the packaged
update and rollback rehearsal could start. The operator-triggered unsafe-update
refusal remains NOT RUN, so that review finding is still open.

## Current run

- Date: 28 November 2026.
- Product commit: `ffb799e1b66e1dbfeb3fc65c13141f3abc9df009`.
- Environment: fresh secondary dev stack, slot 1. Slot 2 holds the live pilot.
- Admission: the runner waited through high load and another slot-1 operation.
  It claimed slot 1 after 328 seconds below the load limit, with CI and both image
  approvals already passed.
- FAIL: `nice -n 10 infra/dev-stack/up.sh --fresh --id 1` reached the built-in
  browser chat check. The browser waited 30 seconds for the streaming cursor
  (`.caret`) to appear, then timed out. No browser transport failure was reported.
  The cause is not established.
- NOT RUN: the separate `journey.sh` check, the populated package update and
  rollback, their browser checks at both widths, and the corrupt-backup refusal.
  The earlier PASS below does not cover the changed recovery and volume checks.
- FAIL, then PASS: the first teardown hit `ESRCH: no such process, read` and left
  services running. After checking that the slot still belonged to this worktree,
  a separate guarded `down.sh --id 1` finished cleanup. Two status checks reported
  `free`. The journey failure was not retried or changed into a PASS.

The runner retained 25 startup and service log files before its first teardown.
The saved `last-error.log` records the browser timeout. The cleanup failure and
successful continuation are recorded in `failure.log` and `down-resume.log` in the
private cleanup receipt. Raw logs and admission samples stay outside the repository.
The log collector missed `chat-failure.png`; teardown removed that screenshot.
There is no current browser screenshot evidence for this run.

The new fleet guard prevents this marked task from running update or rollback.
Authorisation for a separate process without that marker on disposable slot 1
was requested and remains pending. No such process ran. The prepared refusal
probe corrupts a newly completed backup, checks refusal before Helm changes, then
checks the saved chat, original PDF bytes and new replies. It remains untested live.

A new complete fresh journey is required because the fixes change backup-lock
recovery and the check of recorded volumes. It must include the operator refusal
and post-rollback browser checks before teardown. The owner stack, live pilot and
Tailscale Serve were left alone. This worktree is retained for review.

## Current source checks

- PASS: 42 focused Node tests twice, including Docker source permissions and a
  real build timeout with a child and grandchild that ignore SIGTERM.
- PASS: 18 focused backup tests.
- PASS: all 14 guard-removal probes cause the intended assertion failure. They
  cover both fleet entrypoints and every safeguard gap named in the review.
- PASS: typecheck, `check:events` (175 event types), Knip, changelog, Markdown,
  README checks, public privacy and secret scans.
- PASS: scoped ESLint for the builder files. The repository excludes
  infrastructure from ESLint. A separate ESLint check applied function-size,
  parameter, complexity, depth and brace rules to the changed update modules,
  fixture and tests, without warnings.
- PASS: [CI](https://github.com/elewa-git/opencrane-new/actions/runs/46162041318),
  [application approval](https://github.com/elewa-git/opencrane-new/actions/runs/46162086140)
  and [scanner approval](https://github.com/elewa-git/opencrane-new/actions/runs/46162088950)
  for that exact product commit. Both approval artifact sets were unexpired.
- NOT RUN: full local root test suite, as requested.

The small [current result summary](rework-checks.json) records these outcomes.
The source fixes were preceded by test commit `0e372fb6e`. They refuse fleet
maintenance, let recovery resume its saved lock, retain added homes, and force
cancelled build children to stop after five seconds. The updated guide records
these behaviours and the remaining live checks.

## Previous run

The earlier interrupted attempt was repeated before these fixes. That run kept
slot 1 installed until every check below passed. Its result is historical evidence.

### Run details

- Date: 28 November 2026.
- Environment: fresh packaged installation in `opencrane-package-1`, claimed slot 1.
- Previous main: `86a33d13014cb72f785cfb1f3619573a70745961`.
- Approved PR product commit: `860daa5725ab8ca09bc380d42a810148ae88d2c8`.
- Journey: install the previous main, create a member, chat, message and shared PDF,
  update to the approved PR commit, then force an update failure and check automatic
  rollback in the browser before cleanup.
- The application and scanner approval artifacts were present and unexpired before
  both package preparations. The update used the approved product commit.
- The documented `OPENCRANE_ACCEPT_DEV_HOST_RISK=accepted-dev-box-366` setting was
  used for this development host's package installation and update commands.
- The small [result summary](result.json) records the image digests and browser checks.
  Safe run logs are retained outside the repository as `source-run.log`,
  `upgrade-run.log`, `package-upgrade.log` and `expected-update-failure.log`.

### Steps and results

1. PASS: prepare and install the previous-main package on fresh slot-1 storage.
   Sign in as the first owner, connect the local stand-in, invite a member and enable
   member chats.
2. PASS: the invited member signs in, sends a message and receives a completed reply
   at 1280 px. The member downloads the shared PDF byte-for-byte. The saved chat and
   original PDF also work at 390 px.
3. PASS: update the populated package to the approved PR product commit. The copied
   backup verifies before the change. The namespace, volumes, sign-in Secret and
   completed setup job keep their identities. The updated release uses the recorded
   image pins. Sign-in, saved chat, original PDF and a new reply pass at 1280 and
   390 px.
4. PASS: guarded manual rollback returns to the recorded previous image pins and
   keeps the saved data and installation identities.
5. PASS: force the next update to fail by giving the disposable web deployment an
   unreachable readiness port. Automatic rollback restores the recorded image pins
   and data. Before teardown, the member signs in, reads the old chat, downloads the
   original PDF byte-for-byte and completes a new reply at both 1280 and 390 px.
6. PASS: save screenshots and the result summary, then remove the temporary sign-in
   app and tear down slot 1.

### Screenshots

| Check | 1280 px | 390 px |
| --- | --- | --- |
| Previous-main member chat | [Chat](screenshots/member-chat-1280.png) | [Chat](screenshots/member-chat-390.png) |
| Updated saved chat | [Chat](screenshots/updated-1280.png) | [Chat](screenshots/updated-390.png) |
| Updated original PDF preview | [Preview](screenshots/updated-file-1280.png) | [Preview](screenshots/updated-file-390.png) |
| Updated new reply | [Reply](screenshots/updated-new-reply-1280.png) | [Reply](screenshots/updated-new-reply-390.png) |
| Chat after automatic rollback | [Chat](screenshots/automatic-rollback-1280.png) | [Chat](screenshots/automatic-rollback-390.png) |
| Original PDF after automatic rollback | [Preview](screenshots/automatic-rollback-file-1280.png) | [Preview](screenshots/automatic-rollback-file-390.png) |
| New reply after automatic rollback | [Reply](screenshots/automatic-rollback-new-reply-1280.png) | [Reply](screenshots/automatic-rollback-new-reply-390.png) |

### Source checks

The package update ran at approved product commit `860daa5725ab8ca09bc380d42a810148ae88d2c8`.

- PASS: [CI](https://github.com/elewa-git/opencrane-new/actions/runs/46140906796),
  [application approval](https://github.com/elewa-git/opencrane-new/actions/runs/46140903233)
  and [scanner approval](https://github.com/elewa-git/opencrane-new/actions/runs/46140905289)
  passed for that exact commit, with artifacts available for this run.
- PASS: the previously recorded gateway, rollback, backup, image, typecheck,
  event-catalogue, Knip, changelog, Markdown and scoped ESLint checks remain as listed
  in the source receipt. No product source changed during this journey rerun.
- PASS: current Markdown lint, typecheck, `check:events` (175 event types), changelog,
  public privacy and secret scans. Knip completed with two existing configuration hints.
- NOT RUN: full root test suite, as requested.
- NOT CLAIMED: independent review.

### Safety and cleanup

Only slot 1 was used. Slot 2's live pilot, the owner stack, port 44200 and Tailscale
Serve were left alone. The temporary sign-in app was limited to the `OpenCrane 2 Dev`
organisation and removed after the browser checks. The stack was torn down only after
the post-rollback screenshots and result summary were saved. Raw logs and private
inputs remain outside the repository.
