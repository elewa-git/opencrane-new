# Populated pilot update and rollback

Journey on a fresh dev stack: NOT RUN

The source checks are running. The fresh packaged journey will use slot 1 after
CI and both exact-source image approvals pass. The live pilot is excluded.

## Planned checks

1. Install the previous main on empty storage and create a member, a chat and a shared file.
2. Apply the approved update and check sign-in, the old chat and file, and a new reply
   at 1280 and 390 px with the stand-in model.
3. Force a readiness failure during another update. Check automatic rollback,
   the same saved data and a new reply at both widths.
4. Keep screenshots and a safe step list here, copy logs outside the repository,
   and release slot 1.

## Checks seen so far

- PASS: failing-first gateway tests caught the placeholder after both Helm operations.
- PASS: a real non-root container reproduced unreadable shared source after private
  extraction. The same permission check passed after the Dockerfile fix.
- PASS: the maintenance render test first failed because writers still had one replica.
- PASS: the repeat-switch test first failed because a replaced listener was accepted.
- NOT RUN: live Tailscale changes; these remain with the operator.
