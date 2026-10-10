# Recipient picker screen checks

Date: 10 October 2026. Source: round 1 fixes for PR #316. Environment: local production
web build, Chromium and intercepted API replies; not a fresh server installation.

At 1280px and 390px, the picker shows the first three names and a Review all button.
Pressing Enter opens a full-screen dialog with all four names. The dialog moves focus to
its heading. A group with more than three people cannot be sent until the person opens
this review. The browser check confirmed that reviewing the group did not create a chat
and that the page did not scroll sideways.

Component tests also cover returning focus from the audience dialog, loading group page
two with its cursor, and keeping status recovery visible after a group message reply is
lost. Web tests passed: 41 files, 600 tests. The web typecheck and production build passed.
These checks use fixtures. They do not qualify a fresh installation or prove the live
server's group snapshot and create journey.

- [1280px group picker](captures/THR-06-1280.png)
- [390px group picker](captures/THR-06-390.png)
- [1280px full audience review](captures/THR-06-audience-1280.png)
- [390px full audience review](captures/THR-06-audience-390.png)
