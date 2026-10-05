# apps/web

## What this is

The website people use to chat with their assistant and manage an OpenCrane organisation. It runs in a browser and sends requests to `apps/server`, the back end. Passwords go to the sign-in service, not to the website.

## Where it fits

This is the browser app layer. It talks to `apps/server` over web requests and a live connection. The shared message rules in `libs/protocol` check data before the website shows it.

```mermaid
flowchart LR
  web["apps/web<br/>the website"] -->|requests and live updates| server["apps/server<br/>the back end"]
  web -.->|uses| protocol["libs/protocol<br/>message rules"]
```

## What it is responsible for

- Shows sign-in and the first-owner claim page.
- Lets people start conversations, send messages and stop a reply.
- Shows tool approval requests, uploaded files and the assistant's desktop.
- Gives admins pages for integrations, models, spending and change history.
- Clears private information when the server refuses access.
- Adapts the workspace and menus for phones and desktop screens.
- Supports keyboard use in menus, dialogs and the chat workspace.
- Not built yet: the organisation overview, People & groups and Routines pages.
- Not built yet: several personal settings pages, which show an unavailable message.

## Processes it handles

1. **A person signs in.** The website sends them to the sign-in service. After sign-in, it returns them to the page they opened.
2. **A person sends a message.** The website opens a conversation and sends the message to the server. It shows the reply as it arrives and offers Stop.
3. **An admin reviews a tool.** The website shows the tools found on a registered server. The admin can allow, ask before use or block each tool.
4. **A person watches a computer.** The website opens a read-only live view. A screenshot can be saved to the conversation.
5. **An admin checks a change.** The website shows organisation history to people with access.

## How to run or test it

```sh
npm run dev -w apps/web
npm run build -w apps/web
npm run typecheck -w apps/web
```

## Where to read more

- [README.robot.md](README.robot.md): routes, message details, limits and test commands.
- [apps/server](../server/README.md) handles the website's requests.
- [Why a computer keeps its disk when it sleeps](../../docs/adr/0006-computer-disk-and-live-view.md).
- [The shared words used in these guides](../../GLOSSARY.md).
