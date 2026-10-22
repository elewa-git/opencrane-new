# Chat images

This folder holds the rice-paper image used in the website's backgrounds. The texture supports the paper appearance shared by chat and other pages.

## What it is responsible for

- Supplies one background image at a stable browser address.
- Lets shared styles repeat the texture across a page.
- Keeps the image separate from the code that draws conversations.

## Main files

| File | What it does |
| --- | --- |
| `rice-paper.jpg` | Provides the repeating paper texture. |

## How it connects

The [public folder](../README.md) is copied into the website build.
[Shared website styles](../../src/styles.css) load `/chat/rice-paper.jpg` and repeat
it as a background. The browser requests the image when those styles apply;
[chat code](../../src/app/chat/README.md) does not import it directly.
The folder contains no uploaded files, screenshots or conversation data.
