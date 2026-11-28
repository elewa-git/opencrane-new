# Populated pilot update and rollback

Journey on a fresh dev stack: FAIL

The update passed at 1280 and 390 px. Automatic rollback restored the recorded
images and passed health and storage checks. The final browser checks were
interrupted by the rehearsal controller's cleanup. The complete journey has not
passed and this slice is not ready to merge.

## Steps and results

1. PASS: ordinary fresh-stack startup and its built-in browser checks at both widths.
2. PASS: install the approved previous main on fresh slot-1 storage. Claim the
   installation, connect the stand-in provider, invite a member, send a message
   and attach a PDF through the browser.
3. PASS: run `infra/dev-stack/run.sh package-upgrade --id 1` at the approved
   product commit. A new copied backup verifies before Helm changes. The command
   builds and checks the computer image, repairs the gateway and restarts computers.
4. PASS: sign in again at 1280 and 390 px. Read the saved conversation, download
   the original PDF byte-for-byte, open its preview and complete a new assistant reply.
5. PASS: the guarded rollback restores the earlier release. Force another update
   to fail by giving this disposable web deployment an unreachable readiness port
   and a 30-second rollout deadline. Automatic rollback restores the recorded
   image pins. Namespace, volumes, sign-in Secret and completed setup job keep
   their identities. The original messages and file remain in the saved data.
6. FAIL: post-rollback sign-in at 1280 px returned HTTP 502 after the rehearsal
   cleanup removed the namespace. NOT RUN: post-rollback file and reply checks,
   including the 390 px checks. This does not establish a product sign-in defect.
7. PASS: earlier startup and service logs and screenshots were copied before
   teardown. PARTIAL: the cleanup race prevented a final post-rollback service-log
   capture. Slot 1 is released and the temporary sign-in application is removed.

## What remains

The complete fresh packaged journey needs another run with one controller kept
alive until the final browser checks finish. Sign-in, the original chat and PDF,
and a new reply must pass at both widths after automatic rollback. No further
product defect was established before the agreed time limit.

The first three browser attempts stopped on outdated driver assumptions: the
owner's welcome survey, the saved-default confirmation and the member's immediate
welcome redirect after joining. Each attempt's logs were saved before teardown.
The corrected driver reached the populated update successfully. During the final
attempt, managing the controller timers caused an early cleanup to wait for the
package command lock. It removed the installation just before the last sign-in.

## Screenshots

| Check | 1280 px | 390 px |
| --- | --- | --- |
| Previous-main chat | [Chat](screenshots/member-chat-1280.png) | [Chat and PDF](screenshots/member-chat-390.png) |
| Updated saved chat | [Chat](screenshots/updated-1280.png) | [Chat](screenshots/updated-390.png) |
| Updated file preview | [Preview](screenshots/updated-file-1280.png) | [Preview](screenshots/updated-file-390.png) |
| New reply after update | [Reply](screenshots/updated-new-reply-1280.png) | [Reply](screenshots/updated-new-reply-390.png) |
| Interrupted rollback check | [HTTP 502 after cleanup](screenshots/rollback-check-stopped-1280.png) | NOT RUN |

## Source checks

The approved product commit is `860daa5725ab8ca09bc380d42a810148ae88d2c8`.
The previous-main commit is `86a33d13014cb72f785cfb1f3619573a70745961`.

- PASS: [CI](https://github.com/elewa-git/opencrane-new/actions/runs/46140906796),
  [application approval](https://github.com/elewa-git/opencrane-new/actions/runs/46140903233)
  and [scanner approval](https://github.com/elewa-git/opencrane-new/actions/runs/46140905289)
  passed for the exact product commit before the packaged journey.
- PASS: the gateway and rollback tests first failed on the placeholder address.
  They pass with the gateway reapplied after each Helm operation.
- PASS: a real container running as UID 1000 first failed to read source files
  extracted with private permissions. It can read and import them after the fix.
- PASS: tests first caught running writers during maintenance and a replaced
  listener during a repeated route switch. Both pass after their fixes.
- PASS: changed Node tests twice, focused package checks and 19 backup Vitest
  tests twice. The final claim and update tests passed twice: 58 tests per run.
- PASS: typecheck, event catalogue, Knip, changelog, Markdown and README checks.
- PASS: scoped ESLint for configured files. The repository configuration excludes
  the infrastructure files. No new function warnings were accepted.
- PASS: privacy and secret checks before the product push.
- NOT RUN: local web tests and build; no web application source changed.

## Code cleanup

Update, backup and computer work have separate small functions. The code reuses
backup validation, scanner approval checks, computer ownership checks and the
existing image builder. The earlier readiness-only rollback was removed.
Computers resume from their current lifecycle events, including when they become
idle during the build. Changed functions have at most 80 counted lines and five
parameters. Shipped code totals 594 added plus deleted lines.

## Safety and retained evidence

Only slot 1 was used. The live pilot, owner stack and Tailscale Serve were left
alone. The documented `OPENCRANE_ACCEPT_DEV_HOST_RISK` setting was used for the
packaged install on this development box. Image approvals came from the official
CI workflows.

Startup and service logs were copied before each teardown. Raw logs and private
inputs are retained outside the repository. The files include `startup.log`,
`source-run.log`, `upgrade-run.log`, `failure.log` and `computer-build.log` when
those steps ran. This receipt records checks performed by the builder; it does
not claim an independent review.
