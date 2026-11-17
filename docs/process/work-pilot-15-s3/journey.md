# Pilot backup restore journey

Journey on a fresh dev stack: PASS

Run date: 17 November 2026. Qualified source:
[547b8bac1](https://github.com/elewa-git/opencrane-new/commit/547b8bac1530b5013b5443c0444dd4b8b0648b17).
Images came from the successful CI
[application approval](https://github.com/elewa-git/opencrane-new/actions/runs/44175150216)
and [scanner approval](https://github.com/elewa-git/opencrane-new/actions/runs/44175157986).
See the pull request for the final-head image approvals and repeat.
The model uses the local stand-in; this does not qualify a real provider.

## Steps observed

1. Claim a fresh secondary slot. Run `package-prepare`, `package-up` and
   `package-check` with the exact-source approved images.
2. Sign in through the development identity provider. Start a chat, upload
   `project.pdf` and read its project code, `Willow-47`. Download the PDF and
   compare its complete bytes and SHA-256 with the upload, at 1280 px and 390 px.
3. Create a Job from the installed scheduled-backup CronJob. Check the completed
   event, database and file set with the catalogue. Its event position is 46.
4. Attempt restore into the running source. Require `non_empty` refusal and
   identical prior event history, checked through position 47.
5. Send a later message, retain the completed set privately and remove the source.
   Run `down`, claim a clean slot and install restore mode. Check a new namespace
   UID and new volume UIDs before importing the saved set. Stop its catalogue.
6. Inject an exit with status 137 immediately after native events are restored
   and the database stage is durably recorded. Check that the reader remains
   stopped. Create a second Job running the normal packaged restore CLI.
7. Sign in as the same person at both widths. Read the saved reply and require the
   later message to be absent. Download the original PDF and compare its bytes.
   Check anonymous history refusal and `restore_read_only` on an owner-claim write.
8. Require event position 46 after browser reads. Check workers and scheduled
   backup remain held. Rerun the completed restore, repeat both browser widths
   and downloads, and require the event position to remain 46.
9. Run `package-down` and `down`. Both return status 0; the slot is released.

## Results

| Condition | Result |
| --- | --- |
| Fresh source sign-in, chat, upload and identical download at both widths | PASS |
| Complete scheduled backup and catalogue verification | PASS |
| Non-empty refusal without changing prior event history | PASS |
| Source removed; destination namespace and volumes are new | PASS |
| Crash after durable native events; reader stays stopped | PASS |
| Normal packaged CLI resumes and verifies all three parts | PASS |
| Restored sign-in, saved chat and identical download at both widths | PASS |
| Denied anonymous read, held write and no appended events | PASS |
| Completed rerun and repeated browser checks | PASS |
| Package teardown and slot release | PASS |

## Screenshots

- [Source at 1280 px](screenshots/source-1280.png)
- [Source at 390 px](screenshots/source-390.png)
- [Restored at 1280 px](screenshots/restored-1280.png)
- [Restored at 390 px](screenshots/restored-390.png)

## Other evidence and limits

Changed tests passed twice: 116 executed Vitest files, the five Node test files,
and the native-memory recall configuration. Typecheck, `check:events`, knip,
changed-file ESLint with zero warnings, changelog lint, Markdown lint,
whole-stream-read lint and README checks passed. Privacy and secret scans passed.
The desktop-view opt-in file, real-provider case and approval-browser opt-in case
were NOT RUN. Independent review is NOT RUN; the orchestrator runs those reviews.

A supplementary ordinary secondary stack passed fresh `up`, `status` and `down`
on the earlier source commit `100c07f00`. The packaged journey above is the complete
restore qualification for the final production code.

Earlier attempts failed on catalogue startup, patch-file stdin and journal remount
permissions; those causes were fixed before this pass. Harness history-loading
and asynchronous-suspension races were corrected. One destination attempt was
NOT RUN when `package-prepare` refused reused approval directories; normal teardown
and a fresh claim resolved it. Every claimed installation was cleaned up.
