# Fresh development stack journey

**PASS** on 27 November 2026. Source `d778ee1f31b90c45022a614bd61b0714c24cb107`.
Slot 1 started from scratch at 03:05 UTC with the default owner setup and
stand-in model. The one-minute host load stayed below 6 for five minutes before
the claim.

1. Run `infra/dev-stack/up.sh --fresh --id 1`. The launcher saved the first
   ownership record, confirmed the owner's permissions and started the website.
   The website readiness check took about 50 seconds.
2. Let the default CORE checks run in Playwright against the stack. The member
   signed in at 1280 px and 390 px, sent a message and reloaded to check the
   saved reply. Stopping a second reply kept its partial text after reload.
   PDF upload and preview passed at both widths. The scanner refused EICAR.
3. Open the computer from the chat at each width. The view refused access before
   a grant, showed the desktop while the assistant replied after a grant, and
   cleared the picture after access was removed. It cleared in 494 ms at
   1280 px and 385 ms at 390 px.
4. Check private action history and spending at both widths. Another member
   and the owner were refused access to the member's private history. The
   budget blocked calls above the saved limit, including after reload.
5. Check sign-out, sign back in and verify the rebuilt members and tool
   catalogue tables. All CORE checks passed. The separate long-chat approval
   journey was outside this run.
6. Run `infra/dev-stack/status.sh --id 1`. The stack reported healthy. The
   first terminal monitor ended during the run. A second monitor observed the
   completed CORE and stack-ready messages from the same startup.
7. Save the screenshots and logs, then run `infra/dev-stack/down.sh --id 1`.
   Slot 1 reported free. The run logs are `startup.log`, `status.log` and
   `down.log`.

| Evidence | 1280 px | 390 px |
| --- | --- | --- |
| Saved and stopped replies | [Workspace](screenshots/workspace-1280.png) | [Workspace](screenshots/workspace-390.png) |
| Desktop access removed | [Cleared view](screenshots/conversation-revoked-1280.png) | [Cleared view](screenshots/conversation-revoked-390.png) |

The JetStream tests supplied the competing writes. Five real writes first
reproduced the startup error on the original code. With the fix, seeding waited,
reread membership and saved one ownership record. Continuous contention
reached the deadline with the ownership stream still empty.
