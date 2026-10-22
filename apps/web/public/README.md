# Public files

This folder holds files the browser can load directly from the website. They provide the browser-tab icon and the paper texture used by the website's styling.

## What it is responsible for

- Supplies the tab icon through the website's opening HTML page.
- Keeps the chat texture at a stable public address.
- Makes these files available without a TypeScript import.

## Main files

| File | What it does |
| --- | --- |
| `favicon.ico` | Provides the icon requested by the browser for its tab. |
| [chat](chat/README.md) | Holds the rice-paper background image. |

## How it connects

[The Angular build settings](../angular.json) copy this folder into the built website.
[The opening page](../src/index.html) loads `/favicon.ico`, and
[shared website styles](../src/styles.css) load the chat image.
These are public assets, so they contain no private chat data or credentials.
