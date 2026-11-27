# First send in a new assistant session

**NOT RUN.** Slot 1 requires an approved application image for the product commit
`ef103ecb24f7eb587e09ef2731e7253a16b28b1b`. The application approval failed while
testing owner setup with stand-in services and produced no image. The same check
failed on the base commit. Hosted CI and the scanner approval passed.

[Application approval](https://github.com/elewa-git/opencrane-new/actions/runs/45969108653),
[base application approval](https://github.com/elewa-git/opencrane-new/actions/runs/45958706774),
[hosted CI](https://github.com/elewa-git/opencrane-new/actions/runs/45969101439),
[scanner approval](https://github.com/elewa-git/opencrane-new/actions/runs/45969108990).

## Browser steps pending

1. The owner invites a new member on a fresh packaged install in slot 1. The
   member accepts the invitation and opens the workspace.
2. At 1280 px, the member opens three new sessions in a row. In each session,
   the member sends the first message, watches for the uncertain-send warning
   and checks that the message is still there after reloading.
3. At 390 px, the member repeats those steps in three more new sessions.

Slot 1 remained unclaimed by this task. Startup, browser checks and screenshots
are pending.
