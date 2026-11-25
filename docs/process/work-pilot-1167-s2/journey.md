# Pilot backup and restore

Journey on a fresh dev stack: PASS

The rehearsal on 25 November 2026 used product revision
`c01be8a4043ce94bb4e9f22f2d6d2ae08ed3daa1`, with green hosted CI and current
application and scanner approvals for that revision.
[Hosted CI](https://github.com/elewa-git/opencrane-new/actions/runs/45689862582),
[application approval](https://github.com/elewa-git/opencrane-new/actions/runs/45689871155)
and [scanner approval](https://github.com/elewa-git/opencrane-new/actions/runs/45689871534).

## Rehearsal

1. **PASS** Slot 1 was free and the one-minute load stayed below six for five
   minutes before each claim. Ordinary fresh startup, status and the browser
   journey passed, and the slot was released.
2. **PASS** Installed a fresh source package. The owner signed in, claimed the
   install, connected the free test provider and invited a member. The member
   sent a prompt and got a completed reply, then opened the same chat at both
   widths. The loopback listener matched the forwarder for the claimed slot.
   [Provider setup](screenshots/provider-connected.png),
   [source at 1280 px](screenshots/member-chat-1280.png) and
   [source at 390 px](screenshots/member-chat-390.png).
3. **PASS** Confirmed the nightly 02:00 UTC schedule. Moved only the disposable
   CronJob to 21:13 UTC so Kubernetes would start the scheduled Job during the
   rehearsal. It completed at 21:14 UTC. The catalogue's `list` and `show` commands
   agreed on one verified set. It held 90 events, four databases, 16 checkpoints
   and an empty file inventory. The verified archive was saved outside the
   source slot. Import into the original namespace was refused before the source
   was removed.
4. **PASS** Reinstalled on slot 1 with a new namespace ID, volume claims and
   backing volumes. The checked import accepted the archive. The restore Job
   verified the contents and opened reading. The listener matched the new
   package's forwarder.
5. **PASS** The same member signed in to the recovery install and saw the
   original prompt and reply in the same conversation at both widths.
   [Restored chat at 1280 px](screenshots/restored-chat-1280.png) and
   [restored chat at 390 px](screenshots/restored-chat-390.png).
6. **PASS** At each width, the member tried to send a new message. The server
   returned HTTP 503 with `restore_read_only`, and reloading showed that the
   message had not been saved. The browser displayed its general send warning.
   [Attempt at 1280 px](screenshots/write-refused-1280.png) and
   [attempt at 390 px](screenshots/write-refused-390.png).
7. **PASS** Retained the screenshots before teardown, released slot 1 and
   removed the temporary sign-in app.

Both package starts recorded the documented local `accepted-dev-box-366`
exception for the F1 swap and F2 crash-dump checks. The rehearsal used a
private loopback HTTPS origin and synthetic chat data. Actual Tailscale
Serve changes are **NOT RUN**. The switch and rollback rules were checked
with fixtures.

## Regression checks

The earlier Job log recorded only the failed `verify` stage. Against a
disposable PostgreSQL database, the verifier still saw a checkpoint reader
after the pool reported shutdown in 34 of 300 trials. It saw none in 300
trials with explicit client shutdown. A regression reproduced the failed
`verify` stage before the fix and then published a checked set with the fix.

The 64 route, archive and slot tests passed twice. The Vitest runs passed
46 and 72 tests, with the same backup tests in both runs. Hosted checks first
found that a temporary test worktree omitted the shared forwarder module.
The corrected fixture and route tests passed twice, with 28 tests per run.
Typecheck, the event catalogue, Knip, changelog and Markdown lint, the README
check, the whole-stream read check, and the privacy and secret scans passed.
Scoped ESLint reported that the infrastructure files are excluded.

The first local launcher exited before claiming a slot because the pilot slot
marker had no trailing newline. The corrected launcher read the same marker
and then followed the normal slot and load checks.
