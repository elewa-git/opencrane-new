# Mermaid reply screens

These screens use invented assistant replies and intercepted browser requests. They do
not use a development stack or qualify a fresh installation.

| Reply state | 1280 px | 390 px |
| --- | --- | --- |
| Diagram image | [Desktop](diagram-1280.png) | [Phone](diagram-390.png) |
| Source after a drawing error | [Desktop](source-1280.png) | [Phone](source-390.png) |

`npm run visual:chat-mermaid` builds the website and captures these screens. It checks
that the diagram library loads when the diagram arrives, that the image has no active
link or HTML label, and that invalid source stays visible. It also checks page width
and that invalid reply text does not enter browser console messages.

The Chromium regression in `scripts/check-chat-mermaid.mjs` also checks that drawing
cannot make network requests. It tries the reported image shape through the reply
and directly through the library, then tries image, script, stylesheet and fetch
requests inside the sandbox. It checks diagram measurements, lazy loading, protected
settings, one-time initialisation, text and edge limits, and copyable source fallbacks.
`apps/web/test/chat-browser.test.ts` runs this check in browser CI.
