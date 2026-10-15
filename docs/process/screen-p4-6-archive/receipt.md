# Archive screen checks

PASS: `npm run visual:screen-p4-6-archive` captured the archived group chat,
an unknown command result, and the Archived list at 1280 and 390 pixels.
The script used intercepted API replies and reduced motion. It checked for
horizontal overflow and measured the archive controls and list links at 44 pixels.

NOT RUN: a fresh-install journey or a second-device live check. The assistant
workspace header is left for a later part.
