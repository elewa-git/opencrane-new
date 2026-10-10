# Immediate access invalidation: entry points and evidence

Recorded on 10 October 2026 for #85, P4-3 row 7. Base: `bbe76e38`.
This records source behaviour and disposable-service tests. It does not qualify
member departure on a fresh installation. No public removal route is added.

## Membership checks at entry points

A browser cookie identifies a session; it does not prove current membership.
The server resolves the member id and checks stored events. OpenFGA supplies the
remaining permissions. Its `acts_for`, resource-use and team relationships can
remain allowed until cleanup, so those answers cannot replace a membership check.

| Entry point | Event membership check and remaining permission check |
| --- | --- |
| Member headers, colleagues and admin directory (`members/read-routes.ts`) | `currentMembership` and `readActiveMember` read member and ownership facts. Member headers need active membership; the email directory needs Owner/Admin. |
| Member live feed (`realtime.ts`) | `readActiveMember(..., 'admin')` before delivery and on independent polls. A 1,500 ms watchdog stops a hung check. SQL content work cannot block access polling. |
| Invitations, groups, ownership, provider settings and tool administration | `activeMember`, `readActiveMember` or `currentMembership` check member and ownership streams. Writes also check whether those streams changed before append. |
| Chat context, lists, history, message status and message/turn commands (`chat/routes.ts`, `chat/access.ts`) | `activeChatMember` uses `chatMembership`, then OpenFGA membership. `conversationParticipationReader` checks membership before and after conversation permission. Writes load history before their short access check. |
| Personal, direct and group chat sockets (`chat/access.ts`, `chat/realtime.ts`) | Current member and participation positions trigger event reads. Private team sessions also check the actual team. Separate access polling continues during a blocked content read. |
| Group chat choices (`chat/groups.ts`) | The route's `chatAccess` checks current silo membership before `auth.team`. Group event facts and the caller's join receipt establish the group membership. |
| Personal assistant choice and chat creation (`chat/routes.ts`) | The route checks `chatAccess` or `writeChatAccess` before `auth.actsFor`. Shared assistants additionally use `sharedAssistantAuthority`. |
| Private team session reads and turn starts (`chat/private-session.ts`) | `groupMembership` reads silo membership and the actual team before `auth.actsFor`. Writes also use `activeMember`; the paying group is checked separately. |
| Approval GET/POST (`chat/approvals.ts`) | `chatAccess` checks membership for reads. Decisions use `writeChatAccess`, then `currentAuthority` for resource use. |
| File list/download/upload (`files/routes.ts`) | `conversationParticipationReader` checks current membership even if the SQL identity row and OpenFGA permission remain old. Private-session and closure checks still apply. |
| File commands and computer file delivery (`files/commands.ts`) | `verifyCurrentMember` uses `chatMembership` after content history loads. It refuses missing or removed membership before a retry receipt or append. |
| Desktop tickets, upgrades and lease renewals (`computers/view-access.ts`) | `chatMembership` denies inactive membership independently of slower desktop reads. `participation` checks the audience; `auth.view` checks conversation and desktop permissions. Direct grants watch the member and grant streams. Team grants also use `payingGroupAuthority`. |
| Screenshot capture (`computers/screenshots.ts`) | `viewAccess` checks membership before opening the desktop and again during capture. Saving also goes through the guarded file command. |
| Model and MCP decisions (`libs/models/src/decision.ts`, `authority.ts`) | `currentAuthority` reads member-state events and requires their OpenFGA receipts before `auth.actsFor` and both person/assistant `auth.use` checks. An unapplied removal denies rather than trusting old permissions. The decision checks watched positions again before allowing the gateway. |
| Gateway memory recall (`libs/models/src/memory-context.ts`) | `currentAuthority` checks both model and memory resource permissions, including member-state receipts. The saved turn and current computer credential must also match. |
| Browser memory reads/writes (`memory/routes.ts`, `commands-routes.ts`) | `readActiveMember` checks current membership before scope checks call `auth.actsFor` or `auth.use`. Team notes also use `groupMembership`. |
| Pending computer turn tool lists (`chat/bridge-conversation.ts`) | `auth.use` chooses tool metadata from a previously authorised message. Every actual tool call still goes through the current event-based gateway decision above. The list builder itself does not check whether the requester is still a silo member. |
| Computer turn starts and reports (`chat/turns.ts`, `chat/bridge.ts`) | Shared assistant admission uses `activeMember` and `groupMembership`. Personal admission and repeat token issuance do not check whether the requester is still a silo member. Every model/tool request still passes the current event-based decision. |
| Computer/turn credentials (`libs/auth/src/credentials.ts`) | These prove the current computer grant and turn binding, not human membership. Minting a computer token does not authorise model/tool use; each request still passes the event-based decision above. |
| Audit and effect reads (`audit/routes.ts`, `effects/routes.ts`) | `currentMembership` checks current member/owner facts before protected data is returned. |

Paths are relative to `apps/server/src` unless otherwise stated. The names above
are code names; the list contains no customer data or credentials.

## Existing limits outside this change

`GET /api/org/computers` still checks its SQL identity lookup and OpenFGA admin
permission without reading member events. Removal has not been proved to stop
access to that register immediately. The pending tool-list builder also does not
check whether the requester is still a silo member. Personal turn starts and
repeated tokens rely on later model/tool refusal too. These limits are unchanged
by the two last-event fixes. They must be resolved or qualified before reporting
that member departure is complete.

Reads check permission when they begin; an already authorised HTTP content read
is not continuously polled. Streaming browser feeds and desktop bytes do have
independent expiry checks. The closure reader may inspect conversation records
that its worker has not checked yet; desktop freshness never watches that stream.
Personal connections and credential release for personal MCP accounts are absent
in this version. Existing MCP connections are credential-free.

## Failure before the fix

Test commit: `f4e99e0e`, before production changes. Command:

```sh
PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres nice -n 10 npx vitest run \
  apps/server/test/live-view-activity.test.ts \
  apps/server/test/file-upload-failures.test.ts \
  -t 'later invitation|after removal followed' --maxWorkers=1
```

The run failed three assertions:

- A viewer with a hung desktop read stayed open past two seconds after removal
  followed by an invitation.
- A new desktop ticket returned 200 instead of 403 after those events.
- A file command appended an event instead of refusing it. File HTTP reads and
  uploads already refused through the shared participation reader.

The unchanged focused command then passed all four selected cases after both
checks switched to `chatMembership`. SQL and OpenFGA were deliberately left old.
The tests use disposable NATS, PostgreSQL and OpenFGA. The desktop test uses a real
WebSocket with a scripted RFB stream and records frame and close times. It asserts
no desktop bytes after 1,500 ms, close before 2,000 ms, and a saved access-change
stop event. Ticket tests also redeem a ticket minted before removal. The file test
checks the conversation stream position remains unchanged after refusal.

## Verification and remaining qualification

Full results are recorded with the implementation commit and in the draft PR.
Changed tests run twice with `PG_TEST_URL` set. The existing desktop activity tests
throw if a freshness check watches `conversation-chat`; chat messages, files and
turn reports keep the viewer open. Outage, late-reply and watchdog tests retain
the original lease deadlines.

Fresh-install removal, a real desktop canvas on a newly installed silo, live
identity/provider checks and the combined departure/cleanup journey are NOT RUN.
The browser's existing lease tests cover canvas clearing locally; they are not
fresh-install evidence. The full root suite is NOT RUN, as requested. #85 remains
open for the later removal rows and live qualification.
