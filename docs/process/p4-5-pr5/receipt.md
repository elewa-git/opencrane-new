# Recipient picker screen checks

Date: 10 October 2026. Source commit: 37cca16cca1d10542ee5bbcd2ac9d85b40eeb215. Environment: local production
web build, Chromium and intercepted API replies; not a fresh server installation.

The browser run captured the reviewed group at 1280px and 390px, reduced motion at
390px, long name chips and an empty search. It checked that recipient review sends no
create request, changing the group returns focus to the selector, and phone controls
are at least 44px high with no sideways page scroll.

Observed: all assertions passed. The captures were reviewed beside the THR-06 frames.
This is browser evidence with fixtures. It does not qualify a fresh installation or
prove the live server's group snapshot and create journey.

- [1280px group snapshot](captures/THR-06-1280.png)
- [390px group snapshot](captures/THR-06-390.png)
- [390px reduced motion](captures/THR-06-RM-390.png)
- [390px long chips](captures/THR-06-long-chips-390.png)
- [390px empty search](captures/THR-06-empty-search-390.png)
