# Pilot update, backup and recovery

Journey on a fresh dev stack: PASS

The 26 November 2026 rehearsal started from
`2e24538b0e944935f9a3a613693b1b14bc41eec1`.
It applied the package approved for
`da087374d9af47f8752e182157313514a98ed066`. The build and both image approval
workflows passed.
[Hosted CI](https://github.com/elewa-git/opencrane-new/actions/runs/45734418931),
[application approval](https://github.com/elewa-git/opencrane-new/actions/runs/45734457724)
and [scanner approval](https://github.com/elewa-git/opencrane-new/actions/runs/45734458426).

## Rehearsal

1. **PASS** Claimed slot 1 after five minutes with the one-minute load below six.
   Installed the prior package on empty storage. The owner connected the free test
   provider and invited a member. After the member's access was applied, they opened
   a chat, got a completed reply and uploaded a PDF. [Provider setup](screenshots/provider-connected.png),
   [chat at 1280 px](screenshots/member-chat-1280.png) and
   [chat at 390 px](screenshots/member-chat-390.png).
2. **PASS** Applied the approved revision in the existing namespace. The volume
   claims, backing volumes, sign-in Secret, completed setup Job and saved test
   route matched their earlier values. The server, scanner and scheduled backup
   Job referred to the new approved images. The same member signed in, opened
   the saved chat and downloaded the original PDF byte-for-byte at
   [1280 px](screenshots/upgraded-chat-1280.png) and
   [390 px](screenshots/upgraded-chat-390.png).
3. **PASS** Returned to Helm revision 1. The earlier image pins, storage and
   saved test route matched the original install. The same member opened the
   chat and downloaded the same PDF at
   [1280 px](screenshots/rollback-chat-1280.png) and
   [390 px](screenshots/rollback-chat-390.png). Reapplying the approved update
   also passed.
4. **PASS** Confirmed the 02:00 UTC nightly schedule. On this disposable
   installation only, moved it to 01:33 UTC so the scheduler would start the
   normal Job during the rehearsal. The catalogue verified one set with
   95 events, four databases, 16 checkpoints and one 598-byte PDF. The source
   package's image pins matched the manifest. Saved the archive outside the
   installation. Import to the original namespace was refused while it was
   still running.
5. **PASS** Released the source and reserved slot 1 again after five minutes
   below the load limit. The recovery installation had a new namespace,
   volume claims and backing volumes. The import accepted the earlier
   archive and the restore Job verified the events, databases and files.
6. **PASS** The same member opened the original prompt and reply on the
   recovery installation and downloaded the original 598-byte PDF
   byte-for-byte at [1280 px](screenshots/restored-chat-1280.png) and
   [390 px](screenshots/restored-chat-390.png).
7. **PASS** At both widths, sending a new message returned HTTP 503 with
   `restore_read_only`. Reload showed neither attempted message.
   [Write refusal at 1280 px](screenshots/write-refused-1280.png) and
   [write refusal at 390 px](screenshots/write-refused-390.png).
8. **PASS** Saved the screenshots, released slot 1 and removed the temporary
   sign-in app.
9. **PASS** Claimed slot 1 again after five minutes below the load limit.
   `up.sh --fresh --id 1` passed startup and its browser checks. The status
   check passed. The separate `journey.sh --id 1` reported passing sign-in,
   chat, upload and live-view checks at 1280 and 390 px. `down.sh --id 1`
   released the slot. The separate long-chat approval check is **NOT RUN**.

The package installs and updates used the documented local exception for swap
and crash-dump settings. The browser used a private HTTPS test origin. The
saved test route file was checked. Live Tailscale Serve is **NOT RUN**.

The rehearsal script reported a cleanup error after the ordinary stack run
when it looked up the temporary sign-in app again. A check in the dev
organisation confirmed the app had already been removed.

## Checks

- **PASS** 114 Vitest tests passed twice. The Node suites passed with 496 and
  387 tests. The added rollback regression passed twice. The image approval
  tests passed twice with 29 tests each.
- **PASS** Removing each of 18 Serve checks in a fixture caused its matching
  test to fail. The checkpoint tests also caught both missing connections,
  both missing disconnections and a missing wait.
- **PASS** Typecheck, the event catalogue, Knip, changelog and Markdown lint,
  the README and whole-stream read checks, and public privacy and secret
  scans. Scoped ESLint reported that infrastructure files are excluded.

## Earlier attempts

The ordinary stack first stopped at the authenticated scanner check. Earlier
packaged attempts stopped at a missing checkout dependency, a chat timeout
under host load, or a workspace read before the member's access was applied.
The final packaged run used an independent dependency install and confirmed
member access before opening the workspace.

The prior version's claim script ignored the slot argument and could read
slot 2's claim record. Every reservation and stack operation used slot 1.
Later runs used the script that takes an explicit slot.

Helm's global readiness wait held up an earlier update and its rollback because
the running pilot leaves its recovery volume claim unbound. The updated command
checks the workloads that should be running. A later run returned to the earlier
revision but could not fetch the same approval again into the same directory.
The current command keeps each verified download in its own directory. Logs and
failure screenshots were saved before teardown.
