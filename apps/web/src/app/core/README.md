# Browser connections

This folder keeps the website's live connection to the server running. It lets chat pages receive new messages as they arrive and tells them when access has ended.

## What it is responsible for

- Checks incoming messages against the shared message rules before passing them to pages.
- Reconnects after a dropped connection, with varied waits so browsers do not all retry together.
- Stops reconnecting after an access-related closure and tells open chats to clear their content.
- Supplies replaceable browser navigation and connection helpers for checks.

## Main files

| File | What it does |
| --- | --- |
| `websocket.service.ts` | Manages the live connection, recent messages and connection status. |
| `socket-factory.ts` | Supplies browser connections, page addresses and random retry timing. |
| `navigate.ts` | Supplies normal browser page navigation. |

## How it connects

[Chat](../chat/README.md) uses the live connection; [sign-in](../sign-in/README.md)
uses navigation. The connection reaches [the server](../../../../server/README.md)
at `/ws` and uses [shared message rules](../../../../../libs/protocol/README.md).
There is no saved queue of outgoing messages here.
