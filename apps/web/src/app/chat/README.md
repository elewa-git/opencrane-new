# Chat

This folder contains the workspace where people talk to their assistant, exchange messages with colleagues and find earlier conversations. People can also review requested tool actions, open files, read memory and watch the assistant's [computer](../../../../../GLOSSARY.md#computer).

## What it is responsible for

- Runs assistant sessions at `/workspace`, with replies shown as they arrive, uploads, file previews and tool activity. Stop asks the assistant to end its reply; it waits for confirmation, keeps partial text and preserves real failure messages. A budget stop means a spending limit ended work and has its own explanation and reset time.
- Runs colleague chats at `/workspace/direct`. One colleague makes a direct chat; several make a group chat. The first message creates the chat after recipient review. These chats send human text only and start no assistant work. Saved means recorded by the server, rather than delivered to a person.
- Shows Recent and Archived at `/workspace/conversations`, with title search, more results and saved links. A missing chat leaves the authorised list available. Archiving a colleague chat changes only that person's list; the chat stays readable and can receive messages.
- Keeps drafts with their conversations, resumes live updates from the last saved position and records the read place in colleague chats once new messages are visible. Lost access clears messages, drafts, names and files, including late replies.
- Reviews recipients and participants. More than three recipients require a full review before sending. A group chat's creator manages other participants and stays in the chat; others can leave. Company group membership and chat participants are separate lists.
- Shows tool reviews to participants while only the requester can approve or deny. Missing review fields are named. Saved decision, use and end times remain visible; closing a session clears its approval cards. Native consent refusals show their saved reference and grant no permission.
- Opens private sessions with a group's shared assistant at `/workspace/shared`. The person confirms the paying group, whose budget pays for the work. Group membership gives no desktop access. Team work is private by default; the [memory-free](../../../../../GLOSSARY.md#memory-free-turn) choice applies to one turn, uses shared disk and receives no earlier private context.

## Main files

| File | What it does |
| --- | --- |
| `workspace.ts`, `workspace.html`, `composer.*` | Draw the assistant workspace, side panel and message box. |
| `chat-session*.ts`, `chat-state.ts`, `chat-announcement.ts` | Load history, send messages, derive reply status and announce new activity. |
| `direct-chat*.ts`, `direct-chat.html`, `recipient-picker.*` | Handle colleague chats, recipients, participant changes, archives and drafts. |
| `conversations.*`, `conversations-data.ts`, `read-marker.ts` | Load conversation lists, find saved links and save the read place. |
| `approvals.*`, `approval-*.ts`, `tool-activity-line.*` | Show tool reviews, decisions, saved times and safe activity details. |
| `upload.ts`, `file-*.ts`, `conversation-file-card.*`, `screenshot-capture.ts`, `capture-status.*` | Upload, preview and download files, and track screenshot saves. |
| `shared-assistant-picker.*`, `recovery-notice.*`, `memory-free-notice.*`, `budget-stop-notice.*` | Explain shared sessions, recovery, privacy choices and spending stops. |

## Replies and Stop

After Stop, the workspace says “Stopping…” while it waits for an ending report.
After ten seconds without an ending report, it says “Stop not confirmed”.
The reply stays active and Stop can be tried again. A confirmed stopped reply keeps
its partial text and shows its stopped outcome both live and after reload.
Real failures still show “Reply failed”, even when Stop was requested.
A reply whose output was lost stays incomplete; recovery pauses sending and explains why.

## Tool reviews and details

Just before sending an approval or denial, the website finds the latest card by its
saved id. It checks that the request is still open, that the person is the requester,
and that the fields and decision controls still allow that action.

A review stopped by a spending limit stays readable without decision controls,
including after the approval is cancelled. Cancelled cards show the saved reason,
or explain that no reason was recorded. A used card stays on one collapsed line;
its uncertain result and Check status action appear inside its details.
Earlier saved uses remain visible while an approved retry waits to be used again.
Expiry shows the original expiry time and labels the saved end time separately.
The website never invents a missing time from the browser clock.

A native consent refusal shows its saved request reference and server name when known.
It grants no tool permission. Opening its details checks the saved conversation history again.
A reply from an earlier or closed opening cannot change the current drawer.
A failed check keeps the last safe summary and says the check failed.
Closing a session clears approval cards and open approval details; late replies cannot
bring them back.

## Colleague chats and saved lists

Colleague search includes later result pages. Choosing a company group reads its current
members for recipient review. If membership changes before the first send, the person
must choose the group again and review its members. A group message shows its saved
author, using a colleague name when the current colleague list supplies one.
Participant lists mark colleagues who have left the company as removed.
Phones show the participant list with a Back button.

The first send keeps recovery information on screen until its result is known.
A lost reply keeps its original request reference for a status check. Workspace links
stay on the page while the request is unresolved. The same applies to participant
changes and archiving: Recent, Archived, Back and chat selection stay blocked until
the original change can be checked.

A closed live connection cancels an outstanding message read. Reconnecting reads saved
messages again before resuming updates from their last position, then refreshes the
current participants. If saved messages are still being applied, the page briefly retries
the read. Each live connection subscribes once, meaning it asks for that conversation's
updates once. Refreshing after a send keeps that subscription. A busy-server closure
also allows reconnection.

The read place is saved only after all current messages have appeared in a visible
tab near the newest message. Only saved human messages and completed assistant messages
qualify. Assistant-session read markers are not yet handled here. Lost access clears
protected content and moves keyboard focus to the lock notice. Phone headers keep every
chat action visible.

A saved chat link missing from the first page searches Recent and then Archived.
If either list changes during that search, the website starts again at Recent page one
once. Another change offers Retry. Group chat headers use the full saved title.
The assistant workspace does not yet offer archiving from its header.

## Files and screenshots

Uploads stay pending while the server prepares the saved file list. The page checks
again briefly before showing Ready. Leaving the page cancels those checks.
If a screenshot save reply is lost, the website checks Files before offering another
action. The viewer and chat show the same save status and keep keyboard focus while
Files are checked. A saved screenshot appears in the transcript and Files with its
name and capture details. Its preview shows the image and offers download.
Failed saves, scan refusals, failed previews and access changes have separate messages.

## How it connects

[Core](../core/README.md) carries live updates from [the server](../../../../server/README.md).
The workspace embeds [Memory](../memory/README.md) and [Live view](../live-view/README.md),
and uses [shared controls](../ui/README.md).
Uploads are unavailable in private shared-assistant sessions. Keyboard shortcuts, phone
menus, focus restoration and reduced motion are supported.
[Detailed behaviour and checks](../../../README.robot.md#chat-workspace) include retry
rules and the distinction between browser checks and a fresh-install check.
