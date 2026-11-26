# Watch the computer and save a screenshot

**PARTIAL** on a fresh slot 1 dev stack on 26 November 2026. The stack ran
commit `3a08929e03` with the free stand-in provider.

- **PASS** for fresh startup, the stack health check, the repeat browser
  journey and teardown.
- **PASS** for watching a personal chat at 390 px, saving a PNG and opening it
  from the chat and session panel after reloading. The download matched the
  saved SHA-256 digest. [Viewing](fresh-viewer-390.png) ·
  [Saved PNG](fresh-saved-preview-390.png)
- **PASS** for refusing a signed-in outsider at 390 px. The view, capture and
  file requests returned HTTP 403. The browser opened zero desktop sockets
  and received zero desktop bytes. [Chat unavailable](fresh-refused-390.png)
- **PASS** for closing the socket and clearing the picture after removal.
  The repeat at 1280 px took 86 ms and the repeat at 390 px took
  120 ms. [1280 px](access-removed-1280.png) ·
  [390 px](access-removed-390.png)
- **FAIL** for the shared chat setup. The request returned HTTP 425 while
  permissions were applying. The journey now checks the saved request under
  its original ID. The regression passed twice locally.
- **NOT RUN** for the 1280 px personal capture and the shared captures in the
  fresh run that supplied these screenshots.

A fresh run with the journey fix is pending while slot 1 is busy.

The failed attempt's startup and service logs were kept before teardown.
