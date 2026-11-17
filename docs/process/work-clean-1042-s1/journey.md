# Fresh CORE journey

Journey on a fresh dev stack: PASS

- Date: 17 November 2026.
- Tested head: `0e762c212d088fbdcd11796fdb6e6f1e3373052b`.
- Fresh secondary slot: 1; managed calls enabled; free stand-in provider.
- Browser: installed Playwright, separate signed-in contexts, 1280 px and 390 px.
- `infra/dev-stack/up.sh --fresh`: PASS, exit 0.
- `infra/dev-stack/status.sh`: PASS, exit 0; services and readiness healthy.
- `infra/dev-stack/down.sh`: PASS, exit 0; final status reports `free`.
- Screenshots and sanitised startup/service logs were copied before teardown.
  Full sanitised logs and the additional Phase 4 receipt remain in the private
  fleet receipt for this task. No private settings or credentials are committed.

## Steps observed

1. Sign in through Zitadel. Refuse hostile logout requests, a wrong organisation
   and an expired session while retaining valid access.
2. Join the member and wait for their computer and grants. Send a message,
   observe the streamed stand-in reply, reload, then Stop another reply and
   retain its partial text after reload at both widths.
3. Upload and read a PDF. Reload files and open PDF, text and image previews.
   Refuse EICAR, unsupported file types and oversized uploads at both widths.
4. Open the desktop panel. Refuse access without a grant; allow the granted
   desktop; revoke access and clear pixels. Observed revocation was 316 ms at
   390 px and 134 ms at 1280 px.
5. Suspend and wake the computer, then replace its Pod. Preserve its files.
   Show integration rows to an admin and refuse anonymous/member access.
6. Read personal action history. Refuse another member and owner access to
   private history. Save spending ceilings through the browser and refuse
   over-ceiling calls, including after reload, at both widths.
7. Verify both projection replays. Check sign-out, reauthentication, token
   boundaries and loopback listeners.

The existing Phase 4 checks also ran and passed. Their screenshots cover groups,
shared assistants, direct chat, ownership changes and visible refusals. They are
additional evidence; the required clean-code journey is CORE.

Live approvals: NOT RUN. The runner explicitly skips that journey pending its
existing prerequisites. Paid-provider checks: NOT RUN. Shared-assistant disk
isolation: NOT PROVEN; separate member disks and browser profiles are not built. No paid calls were made and no guard was bypassed.

The runner reported one upload retry and zero preview retries at each width.
No fixture retry, timeout, assertion or product code was changed for this run.

[Source gates, test-first commits and deferred server helpers](checks.md).
[Desktop live-view measurements](screenshots/legacy/live-view/conversation-1280.json)
and [mobile measurements](screenshots/legacy/live-view/conversation-390.json).

## Screenshots retained before teardown

| Step | 1280 px | 390 px |
| --- | --- | --- |
| conversation entry (CORE) | [View](screenshots/legacy/live-view/conversation-entry-1280.png) | — |
| conversation revoked (CORE) | [View](screenshots/legacy/live-view/conversation-revoked-1280.png) | — |
| conversation viewer (CORE) | [View](screenshots/legacy/live-view/conversation-viewer-1280.png) | [View](screenshots/legacy/live-view/conversation-viewer-390.png) |
| fresh assistant refusal (CORE) | [View](screenshots/legacy/p3-13-live/fresh-assistant-refusal-1280.png) | [View](screenshots/legacy/p3-13-live/fresh-assistant-refusal-390.png) |
| fresh assistant (CORE) | [View](screenshots/legacy/p3-13-live/fresh-assistant-1280.png) | [View](screenshots/legacy/p3-13-live/fresh-assistant-390.png) |
| fresh paying_group refusal (CORE) | [View](screenshots/legacy/p3-13-live/fresh-paying_group-refusal-1280.png) | [View](screenshots/legacy/p3-13-live/fresh-paying_group-refusal-390.png) |
| fresh paying_group (CORE) | [View](screenshots/legacy/p3-13-live/fresh-paying_group-1280.png) | [View](screenshots/legacy/p3-13-live/fresh-paying_group-390.png) |
| fresh repeat headroom (CORE) | — | [View](screenshots/legacy/p3-13-live/fresh-repeat-headroom-390.png) |
| fresh stub chat (CORE) | [View](screenshots/legacy/p3-13-live/fresh-stub-chat-1280.png) | [View](screenshots/legacy/p3-13-live/fresh-stub-chat-390.png) |
| fresh action (CORE) | [View](screenshots/legacy/p3-19-live/fresh-action-1280.png) | [View](screenshots/legacy/p3-19-live/fresh-action-390.png) |
| fresh category (CORE) | [View](screenshots/legacy/p3-19-live/fresh-category-1280.png) | [View](screenshots/legacy/p3-19-live/fresh-category-390.png) |
| fresh change (CORE) | [View](screenshots/legacy/p3-19-live/fresh-change-1280.png) | [View](screenshots/legacy/p3-19-live/fresh-change-390.png) |
| fresh refused (CORE) | [View](screenshots/legacy/p3-19-live/fresh-refused-1280.png) | [View](screenshots/legacy/p3-19-live/fresh-refused-390.png) |
| fresh stub chat (CORE) | [View](screenshots/legacy/p3-19-live/fresh-stub-chat-1280.png) | [View](screenshots/legacy/p3-19-live/fresh-stub-chat-390.png) |
| direct chat exchange (additional) | [View](screenshots/p4-journey/clean-1042-s1/direct-chat-exchange-1280.png) | [View](screenshots/p4-journey/clean-1042-s1/direct-chat-exchange-390.png) |
| direct chat received (additional) | [View](screenshots/p4-journey/clean-1042-s1/direct-chat-received-1280.png) | [View](screenshots/p4-journey/clean-1042-s1/direct-chat-received-390.png) |
| direct chat recipient (additional) | [View](screenshots/p4-journey/clean-1042-s1/direct-chat-recipient-1280.png) | [View](screenshots/p4-journey/clean-1042-s1/direct-chat-recipient-390.png) |
| group after replay (additional) | [View](screenshots/p4-journey/clean-1042-s1/group-chat/group-after-replay-1280.png) | [View](screenshots/p4-journey/clean-1042-s1/group-chat/group-after-replay-390.png) |
| group created (additional) | [View](screenshots/p4-journey/clean-1042-s1/group-chat/group-created-1280.png) | [View](screenshots/p4-journey/clean-1042-s1/group-chat/group-created-390.png) |
| group denied selection (additional) | [View](screenshots/p4-journey/clean-1042-s1/group-chat/group-denied-selection-1280.png) | [View](screenshots/p4-journey/clean-1042-s1/group-chat/group-denied-selection-390.png) |
| group join position (additional) | [View](screenshots/p4-journey/clean-1042-s1/group-chat/group-join-position-1280.png) | [View](screenshots/p4-journey/clean-1042-s1/group-chat/group-join-position-390.png) |
| group left cleared (additional) | [View](screenshots/p4-journey/clean-1042-s1/group-chat/group-left-cleared-1280.png) | [View](screenshots/p4-journey/clean-1042-s1/group-chat/group-left-cleared-390.png) |
| group messages (additional) | [View](screenshots/p4-journey/clean-1042-s1/group-chat/group-messages-1280.png) | [View](screenshots/p4-journey/clean-1042-s1/group-chat/group-messages-390.png) |
| group mode before send (additional) | [View](screenshots/p4-journey/clean-1042-s1/group-chat/group-mode-before-send-1280.png) | [View](screenshots/p4-journey/clean-1042-s1/group-chat/group-mode-before-send-390.png) |
| group picker (additional) | [View](screenshots/p4-journey/clean-1042-s1/group-chat/group-picker-1280.png) | [View](screenshots/p4-journey/clean-1042-s1/group-chat/group-picker-390.png) |
| group removed cleared (additional) | [View](screenshots/p4-journey/clean-1042-s1/group-chat/group-removed-cleared-1280.png) | [View](screenshots/p4-journey/clean-1042-s1/group-chat/group-removed-cleared-390.png) |
| group unsupported combination (additional) | [View](screenshots/p4-journey/clean-1042-s1/group-chat/group-unsupported-combination-1280.png) | [View](screenshots/p4-journey/clean-1042-s1/group-chat/group-unsupported-combination-390.png) |
| groups created (additional) | [View](screenshots/p4-journey/clean-1042-s1/groups-created-1280.png) | [View](screenshots/p4-journey/clean-1042-s1/groups-created-390.png) |
| groups detail (additional) | [View](screenshots/p4-journey/clean-1042-s1/groups-detail-1280.png) | [View](screenshots/p4-journey/clean-1042-s1/groups-detail-390.png) |
| groups list (additional) | [View](screenshots/p4-journey/clean-1042-s1/groups-list-1280.png) | [View](screenshots/p4-journey/clean-1042-s1/groups-list-390.png) |
| groups removal review (additional) | [View](screenshots/p4-journey/clean-1042-s1/groups-removal-review-1280.png) | [View](screenshots/p4-journey/clean-1042-s1/groups-removal-review-390.png) |
| groups removed (additional) | [View](screenshots/p4-journey/clean-1042-s1/groups-removed-1280.png) | [View](screenshots/p4-journey/clean-1042-s1/groups-removed-390.png) |
| groups search (additional) | [View](screenshots/p4-journey/clean-1042-s1/groups-search-1280.png) | [View](screenshots/p4-journey/clean-1042-s1/groups-search-390.png) |
| ownership actor ready (additional) | [View](screenshots/p4-journey/clean-1042-s1/ownership-actor-ready-1280.png) | [View](screenshots/p4-journey/clean-1042-s1/ownership-actor-ready-390.png) |
| ownership former owner refused (additional) | [View](screenshots/p4-journey/clean-1042-s1/ownership-former-owner-refused-1280.png) | [View](screenshots/p4-journey/clean-1042-s1/ownership-former-owner-refused-390.png) |
| ownership former owner workspace (additional) | [View](screenshots/p4-journey/clean-1042-s1/ownership-former-owner-workspace-1280.png) | [View](screenshots/p4-journey/clean-1042-s1/ownership-former-owner-workspace-390.png) |
| ownership last owner refused (additional) | [View](screenshots/p4-journey/clean-1042-s1/ownership-last-owner-refused-1280.png) | [View](screenshots/p4-journey/clean-1042-s1/ownership-last-owner-refused-390.png) |
| ownership member review (additional) | [View](screenshots/p4-journey/clean-1042-s1/ownership-member-review-1280.png) | [View](screenshots/p4-journey/clean-1042-s1/ownership-member-review-390.png) |
| ownership new owner (additional) | [View](screenshots/p4-journey/clean-1042-s1/ownership-new-owner-1280.png) | [View](screenshots/p4-journey/clean-1042-s1/ownership-new-owner-390.png) |
| ownership step down (additional) | [View](screenshots/p4-journey/clean-1042-s1/ownership-step-down-1280.png) | [View](screenshots/p4-journey/clean-1042-s1/ownership-step-down-390.png) |
| ownership transfer response (additional) | [View](screenshots/p4-journey/clean-1042-s1/ownership-transfer-response-1280.png) | [View](screenshots/p4-journey/clean-1042-s1/ownership-transfer-response-390.png) |
| ownership transfer result (additional) | [View](screenshots/p4-journey/clean-1042-s1/ownership-transfer-result-1280.png) | [View](screenshots/p4-journey/clean-1042-s1/ownership-transfer-result-390.png) |
| ownership transfer review (additional) | [View](screenshots/p4-journey/clean-1042-s1/ownership-transfer-review-1280.png) | [View](screenshots/p4-journey/clean-1042-s1/ownership-transfer-review-390.png) |
| provider key saved (additional) | [View](screenshots/p4-journey/clean-1042-s1/provider-key-saved-1280.png) | [View](screenshots/p4-journey/clean-1042-s1/provider-key-saved-390.png) |
| provider list (additional) | [View](screenshots/p4-journey/clean-1042-s1/provider-list-1280.png) | [View](screenshots/p4-journey/clean-1042-s1/provider-list-390.png) |
| shared assistant choice (additional) | [View](screenshots/p4-journey/clean-1042-s1/shared-assistant-choice-1280.png) | [View](screenshots/p4-journey/clean-1042-s1/shared-assistant-choice-390.png) |
| shared assistant create response (additional) | [View](screenshots/p4-journey/clean-1042-s1/shared-assistant-create-response-1280.png) | [View](screenshots/p4-journey/clean-1042-s1/shared-assistant-create-response-390.png) |
| shared assistant create (additional) | [View](screenshots/p4-journey/clean-1042-s1/shared-assistant-create-1280.png) | [View](screenshots/p4-journey/clean-1042-s1/shared-assistant-create-390.png) |
| shared assistant created (additional) | [View](screenshots/p4-journey/clean-1042-s1/shared-assistant-created-1280.png) | [View](screenshots/p4-journey/clean-1042-s1/shared-assistant-created-390.png) |
| shared assistant private chat (additional) | [View](screenshots/p4-journey/clean-1042-s1/shared-assistant-private-chat-1280.png) | [View](screenshots/p4-journey/clean-1042-s1/shared-assistant-private-chat-390.png) |
| shared assistant review (additional) | [View](screenshots/p4-journey/clean-1042-s1/shared-assistant-review-1280.png) | [View](screenshots/p4-journey/clean-1042-s1/shared-assistant-review-390.png) |
| shared assistant session response (additional) | [View](screenshots/p4-journey/clean-1042-s1/shared-assistant-session-response-1280.png) | [View](screenshots/p4-journey/clean-1042-s1/shared-assistant-session-response-390.png) |
| preview | [View](screenshots/preview-1280.png) | [View](screenshots/preview-390.png) |
| upload preparing | [View](screenshots/upload-preparing-1280.png) | [View](screenshots/upload-preparing-390.png) |
| upload ready | [View](screenshots/upload-ready-1280.png) | [View](screenshots/upload-ready-390.png) |
| upload | [View](screenshots/upload-1280.png) | [View](screenshots/upload-390.png) |
| workspace | [View](screenshots/workspace-1280.png) | [View](screenshots/workspace-390.png) |
