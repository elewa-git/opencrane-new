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

## How it connects

[Core](../core/README.md) carries live updates from [the server](../../../../server/README.md).
The workspace embeds [Memory](../memory/README.md) and [Live view](../live-view/README.md),
and uses [shared controls](../ui/README.md).
Screenshots share one save status in the viewer and transcript. A saved screenshot appears
in Files with capture details; previews offer download. Scan refusals, failed previews
and access changes have separate messages.

Recovery pauses sending and explains lost output without pretending the reply completed.
Uploads are unavailable in private shared-assistant sessions. Keyboard shortcuts, phone
menus, focus restoration and reduced motion are supported.
[Detailed behaviour and checks](../../../README.robot.md#chat-workspace) include retry
rules and the distinction between browser checks and a fresh-install check.
