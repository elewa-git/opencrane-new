# Public files

This folder holds files the browser can load directly from the website. They provide the browser-tab icon, the paper texture and the separate document that draws diagrams without network access.

## What it is responsible for

- Supplies the tab icon through the website's opening HTML page.
- Loads the diagram library only inside a sandboxed document, then blocks network access.
- Keeps the chat texture at a stable public address.
- Makes these files available without a TypeScript import.

## Main files

| File | What it does |
| --- | --- |
| `mermaid-renderer.html`, `mermaid-renderer.js` | Load the diagram library, block network access and draw replies. |
| `favicon.svg`, `favicon.ico` | Show the OpenCrane mark in browser tabs, with an SVG icon and ICO fallback. |
| `apple-touch-icon.png` | Shows the OpenCrane mark when the site is saved to an Apple device's home screen. |
| [chat](chat/README.md) | Holds the rice-paper background image. |

## How it connects

[The Angular build settings](../angular.json) copy this folder into the built website.
[The opening page](../src/index.html) offers the SVG and ICO files for browser tabs and
the PNG file for Apple home screens. [Shared website styles](../src/styles.css) load the chat image.
These are public assets, so they contain no private chat data or credentials.
