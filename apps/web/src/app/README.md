# Website pages

This folder brings together the pages people see in OpenCrane. It chooses the page for the current address and places organisation and personal settings inside their shared menus.

## What it is responsible for

- Opens sign-in, first-owner setup and the welcome survey.
- Chooses assistant chat, colleague chat and conversation lists.
- Places admin pages inside the organisation menu.
- Shows a clear message for missing or unfinished pages.

## Main files

| File | What it does |
| --- | --- |
| `app.ts`, `app.html` | Match the browser address to a page and its surrounding menu. |
| `app.config.ts` | Sets up Angular, the framework that draws and updates the website. |
| `app.css` | Sets the outer page layout. |

## How it connects

[The website entry point](../main.ts) starts this part of the app.
[Chat](chat/README.md), [organisation settings](organisation/README.md) and
[personal settings](settings/README.md) supply its main views.
The [package guide](../../README.md#folders) links every folder.
Page selection does not grant access; the server checks each request.
