# Computers

This folder lets people watch an assistant's desktop, take a screenshot and see computer status. It also contains the first steps for pausing assistant work before a person takes control; taking control is still switched off in normal use.

## What it is responsible for

- Lists computer status for owners and admins.
- Opens a view only for someone with current conversation access and a desktop grant.
- Keeps checking access while the desktop is visible.
- Saves authorised screenshots through the normal file checks.
- Reads saved control requests, including paused and failed results, for chat participants.
- Records control intent when explicitly enabled and helps check that computer work has stopped.
- Saves one short writer lease after quiet proof, renews it within its original deadline, and saves Return.
- Saves refused control attempts separately from the computer, without interrupting work.

Each [computer](../../../../GLOSSARY.md#computer) belongs to one assistant. A personal assistant has its own; a group's assistant uses one shared computer. Viewing holds one place while the connection opens and until it ends. A confirmed member removal or conversation denial ends the view immediately, even while another access check is slow. A later invitation alone does not restore desktop or file access. Starting a turn or receiving a file does not remove viewing access.

A screenshot opens a temporary authorised connection to the assistant's desktop, then passes the picture through the normal [file checks](../files/README.md). No open viewer is needed. People who join a conversation later can see only files and screenshots from their latest join onwards.

When enabled, a control request must name the current requester's message and current computer. Pending intent prevents new work and new AI passes. Authorised viewing, an explicit request to stop a reply and denying an approval remain available. Reading control status does not touch the computer or grant control.

The chat connection sends a signed request to stop work, including to an idle computer. Slow history reads, uploads and replayed reports do not delay it. The immediate reply applies only to that connection; if a turn finishes during signing, the server checks again before resuming reports. It can then ask the root supervisor, the computer's process manager, to stop executors while reports wait. It records pausing after both replies are checked. It records paused only when the current bridge and supervisor both prove that work is quiet. A separate saved lease can then name one requester and one writer session.

The server checks that requester's access again after reading the computer. A clock change cannot make the saved lease last longer.

## Main files

| File | What it does |
| --- | --- |
| [routes.ts](routes.ts) | Lists computers for organisation admins. |
| [view.ts](view.ts), [view-access.ts](view-access.ts) | Opens desktop views and checks current rights. |
| [view-session.ts](view-session.ts), [view-sessions.ts](view-sessions.ts), [view-lease.ts](view-lease.ts) | Track opening places, sessions and short access-check lifetimes. |
| [desktop.ts](desktop.ts), [rfb.ts](rfb.ts), [view-delivery.ts](view-delivery.ts), [view-timing.ts](view-timing.ts) | Carry read-only desktop pictures, limit waiting data and record timings. |
| [screenshots.ts](screenshots.ts), [capture.ts](capture.ts) | Capture one desktop picture and submit it as a file. |
| [takeover-routes.ts](takeover-routes.ts), [takeover.ts](takeover.ts), [stop-executor.ts](stop-executor.ts) | Read or request control preparation and ask the supervisor to stop work. |
| [takeover-refusals.ts](takeover-refusals.ts) | Saves refused attempts and recovers their original result on retry. |
| [writer-lease.ts](writer-lease.ts) | Saves the writer lease and Return, and checks one local writer slot. |

## How it connects

The [server](../../README.md) registers these requests. [Chat](../chat/README.md) supplies conversation access and delivers pause requests. [Members](../members/README.md) checks current membership. The [assistant computer](../../../computer/README.md) supplies desktop pictures over authenticated Kubernetes access, the private management connection to the running computer.

## Not done here

[Background workers](../../../ops/README.md) start, pause and replace computers. Production still refuses control requests. The writer socket is not yet connected to the desktop, and fresh-computer recovery remains later work.
