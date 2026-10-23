# Organisation navigation

This folder supplies the shared frame around organisation settings. People see the organisation name, links to admin pages and a way back to the chat workspace.

## What it is responsible for

- Lists Overview, People & groups, Models & providers, Spending, Integrations, Routines and Change history.
- Marks the current page and recognises member, group, assistant-setup and integration addresses.
- Shows a sidebar on larger screens and a keyboard-friendly menu on phones.
- Opens Integrations for `/org` while Overview has no working screen.

## Main files

| File | What it does |
| --- | --- |
| `organisation-shell.*` | Draw the sidebar, phone header and shared page area. |
| `pages.ts` | Names the pages and matches their addresses. |

## How it connects

[Page selection](../README.md) places [People & groups](../people/README.md),
[Models](../models/README.md), [Spending](../spending/README.md),
[Integrations](../integrations/README.md) and [Change history](../audit/README.md)
inside this frame. [Shared controls](../ui/README.md) supply the brand and phone menu.
Overview and Routines currently show an unavailable message.
The menu itself grants no access; the server checks each page's requests.
