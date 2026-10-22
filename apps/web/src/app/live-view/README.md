# Live view

This folder lets someone watch the assistant's [computer](../../../../../GLOSSARY.md#computer) from the chat workspace. The view is read-only: it shows the desktop without letting the person type, click or use the clipboard there.

## What it is responsible for

- Asks the server for permission before opening the desktop connection.
- Shows connecting, viewing, disconnected and access-changed states.
- Clears the picture when permission expires or the session closes.
- Offers fit-to-window and actual-size views, plus a screenshot action saved through chat.
- Closes on Escape and returns keyboard focus to the opening control.

## Main files

| File | What it does |
| --- | --- |
| `live-view.ts`, `live-view.html`, `live-view.css` | Open the viewing dialog and show connection and screenshot status. |
| `lease-channel.ts` | Checks short-lived viewing permission notices alongside desktop images. |
| `viewer.ts`, `novnc.d.ts` | Load noVNC, the desktop display library, and describe its browser interface. |

## How it connects

[Chat](../chat/README.md) opens the viewer and handles screenshot saving.
[Shared dialogs](../ui/README.md) provide its window and focus behaviour.
[The server](../../../../server/README.md) checks access and forwards desktop images.
Shared-assistant participants need a separate desktop grant, meaning explicit permission.
