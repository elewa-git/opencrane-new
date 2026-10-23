# People and groups

This folder shows People & groups and its member, group and owner pages. Owners and admins can manage membership, review access, create shared assistants and check the outcome of changes.

## What it is responsible for

- Searches and pages through current members, lists groups and creates local groups. Temporary failures keep earlier rows; access refusals clear both lists.
- Shows a member's role, groups, assistant and granted access. Phone layouts use labelled cards. Restricted readers see only the permitted name and role.
- Changes Member and Admin roles, and reviews departures before removal. The review names lost access, affected personal [computers](../../../../../GLOSSARY.md#computer), shared work needing a decision and retained history. Pending role and removal requests cannot overlap.
- Adds active members to local groups and reviews removals. Changes wait for both saved data and permissions to catch up. Groups managed by a company sign-in service keep their membership controls separate.
- Creates a group's shared assistant with selected model and tool permissions and a fixed paying group, whose budget pays for it. Group membership does not grant desktop access.
- Creates email invitation links and shows their expiry. No email is sent; the Invitations list is unavailable.
- Lists owners and lets an owner appoint an active successor by member ID or step down. Appointment keeps the current owner; stepping down is separate. The server prevents removal of the last owner.

A missing member clears the whole detail page, as does lost access. A temporary
refresh failure keeps earlier details visible. Member details and access details
have separate load times, so a successful member read cannot make older permissions
look newly checked.

An invitation whose save reply is lost keeps its original request for a status check
before showing a link. A shared assistant can belong to a group managed by the company
sign-in service as well as a local group.

## Main files

| File | What it does |
| --- | --- |
| `people-screen.*`, `members-list.*`, `groups-list.*` | Draw the directory, tabs and group creation. |
| `member-detail-screen.*`, `members-api.ts` | Show access, role changes and departure review and outcomes. |
| `group-detail*`, `group-add-panel.*`, `groups-api.ts`, `member-search-api.ts`, `group-wording.ts` | Show group details and handle membership changes and member search. |
| `invite-panel.*`, `shared-assistant-admin.*` | Create invitation links and shared assistants. |
| `ownership-*.ts`, `ownership-screen.html`, `ownership-screen.css` | Review ownership changes and follow their saved results. |

## How it connects

[Organisation](../organisation/README.md) supplies navigation and [shared controls](../ui/README.md)
supply review dialogs. [Chat](../chat/README.md) lets members start private sessions with a shared assistant.
[The server](../../../../server/README.md) checks roles and records every change.
Unconfirmed changes keep their original references; protected details clear when access ends.
