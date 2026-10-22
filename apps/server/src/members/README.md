# Members

This folder manages the people in an OpenCrane installation, their groups and who owns the installation. It handles invitations, joining, role changes and departure checks, so access follows the person's current membership.

## What it is responsible for

- Lets the first owner claim a new installation with a one-time code.
- Prepares, saves and renews invitations, then checks the signed-in person accepting them.
- Lists member details and management choices appropriate to the reader's role.
- Creates groups, changes group membership and records ownership requests and confirmations.
- Reviews a person's access and departure effects without exposing private content.
- Saves reviewed removals and reports whether permission cleanup is applying, complete or unknown.
- Supplies the shared member check used by chat, approvals, files and other requests.

An operator uses the [one-time command](../bootstrap-token.ts) to print a claim code. The first person signs in, enters it on the claim page and becomes the owner after the server checks it. [Signing in](../auth/README.md) alone does not make someone a member.

An admin checks an invitation email without looking the person up in the sign-in service. The person is confirmed on acceptance, after a recent sign-in with a verified email and while the inviter remains an owner or admin. Acceptance records the signed-in account and whether a personal assistant was requested. Member tables help find accounts, but saved changes confirm them, including changes not yet copied into tables. Concurrent invitations cannot admit the same account twice. Renewing an invitation during acceptance makes the old invitation unusable, including its earlier role.

A lost invitation reply can be checked by its original caller; another admin cannot read that command's confirmation. Refusal records keep a fixed-length hash of the request id. Organisation replies tell browsers and caches not to save private information.

Owners and admins receive the member directory, including emails and current management choices. Ordinary members receive only a small header for one person. Active non-owner targets can have their role changed or be removed, including the caller; owners use ownership requests instead. An appointment remains pending until the successor confirms. Competing appointments stay applying until permissions catch up. Group and ownership reads load history before checking current access: removal during a slow read prevents the reply, while unrelated chat activity does not interrupt it. The website exposes these settings in People & groups.

Access reviews use an index of saved grants, groups and assistants. They check new indexed history without rereading for unrelated read acknowledgements. Removed access stays incomplete until permission confirmations arrive. Reviews stop above 100 groups or 500 distinct people, and remain incomplete after an upgrade until the index has been rebuilt. Private retained history appears only as counts and dates. A complete review permits removal. Other people can keep posting messages while departure cleanup proceeds; a lost removal reply can be recovered from saved changes.

The shared guard checks the session, configured organisation, installation, current membership and conversation access. Writes must come from this website. It sets replies to prevent browser caching. It does not read an entire conversation or start the short write access check. Commands load history first, then check only the small records that decide access. Live connections keep checking membership; saved removals take effect before the permissions service catches up.

## Main files

| File | What it does |
| --- | --- |
| [routes.ts](routes.ts), [guard.ts](guard.ts) | Read browser sessions and provide common member checks. |
| [bootstrap.ts](bootstrap.ts), [join.ts](join.ts), [admission.ts](admission.ts) | Claim an installation and confirm invitation acceptance against saved accounts. |
| [invitation-email.ts](invitation-email.ts), [invitation-routes.ts](invitation-routes.ts), [invitations.ts](invitations.ts), [refusals.ts](refusals.ts) | Check invitation input and save invitations, renewals and refusals. |
| [read-routes.ts](read-routes.ts), [read-counts.ts](read-counts.ts) | Return member headers, the admin directory and checked counts. |
| [groups.ts](groups.ts), [group-routes.ts](group-routes.ts) | Manage groups and their saved changes. |
| [ownership.ts](ownership.ts), [ownership-routes.ts](ownership-routes.ts), [roles.ts](roles.ts), [role-routes.ts](role-routes.ts) | Handle ownership, Member/Admin roles and removal requests. |
| [inventory.ts](inventory.ts), [inventory-routes.ts](inventory-routes.ts), [retained-content.ts](retained-content.ts), [removal.ts](removal.ts) | Review access, retained history and departure cleanup. |

## How it connects

The [server](../../README.md) registers these requests. [Auth](../auth/README.md) checks identity; [permissions](../../../../libs/authz/README.md) checks what a member may do. [Background workers](../../../ops/README.md) apply saved membership changes to permissions and read tables. [Assistants](../assistants/README.md), [chat](../chat/README.md) and [onboarding](../onboarding/README.md) use membership and group checks. The server's [realtime helper](../realtime.ts) sends member updates to authorised live connections.
