# Watch the computer and save a screenshot

## Fresh journey run 3 on 27 November 2026

**PASS** on commit `313de7778`. One fresh slot 1 stack ran Chromium with the
stand-in model from 01:36 to 01:54 UTC. Startup, stack health, the core browser
journey, screenshot and refusal checks, and teardown all passed.

| Expected result | 1280 px | 390 px |
| --- | --- | --- |
| Watch a personal computer, save a PNG and reopen it | PASS · [Viewer](run-3/viewer-1280.png) · [Saved PNG](run-3/saved-screenshot-1280.png) | PASS · [Viewer](run-3/viewer-390.png) · [Saved PNG](run-3/saved-screenshot-390.png) |
| Refuse an active member outside the chat with zero pixels | PASS · [Browser](run-3/non-participant-1280.png) | PASS · [Browser](run-3/non-participant-390.png) |
| Refuse a signed-in outsider with zero pixels | PASS · [Browser](run-3/outsider-1280.png) | PASS · [Browser](run-3/outsider-390.png) |
| Close the socket and clear the picture within 2 s of participant removal | PASS · [160 ms](run-3/removed-1280.png) | PASS · [199 ms](run-3/removed-390.png) |

The member reopened the saved PNG from the chat and session panel after
reloading. Each download matched the digest recorded on save. Both refusal
accounts received HTTP 403 for the view, capture and saved file requests. The
refused browsers opened zero desktop sockets, received zero desktop bytes and
rendered zero desktop canvases. Removed participants received HTTP 403 when
they tried to reopen the view. [Measured results](run-3/results.json)

Hosted CI **PASS** on the same commit. Shard 2 passed the regression test for
listing 60 private team sessions. [CI run](https://github.com/elewa-git/opencrane-new/actions/runs/45920176487)

## Final fix journey on 27 November 2026

**NOT RUN** on commit `bfb39e78b`. Slot 1 was free during parts of the
wait. It became busy as the five-minute low-load windows ended at 00:23
and 00:48 UTC. The slot and load requirements did not hold together again
before the startup cutoff. The checks are recorded in `journey-progress.log`.

| Expected result | 1280 px | 390 px |
| --- | --- | --- |
| Watch a personal computer, save a PNG and reopen it | NOT RUN | NOT RUN |
| Refuse an active member outside the chat with zero pixels | NOT RUN | NOT RUN |
| Refuse a signed-in outsider with zero pixels | NOT RUN | NOT RUN |
| Close the socket and clear the picture within 2 s of participant removal | NOT RUN | NOT RUN |

Fresh startup, the browser checks and teardown were **NOT RUN**. This
attempt did not acquire a slot.

## Fresh journey run 2 on 26 November 2026

**PARTIAL** on commit `845ac02c1`. One fresh slot 1 stack ran Chromium
with the free stand-in provider from 20:34 to 21:02 UTC. Fresh startup, stack
health, the core browser journey and teardown all passed.

| Expected result | 1280 px | 390 px |
| --- | --- | --- |
| A member watches their personal computer, saves a PNG and reopens it | PASS · [Viewer](run-2/fresh-personal-viewer-1280.png) · [Saved PNG](run-2/fresh-personal-reloaded-preview-1280.png) | PASS · [Viewer](run-2/fresh-personal-viewer-390.png) · [Saved PNG](run-2/fresh-personal-reloaded-preview-390.png) |
| A shared-chat reader watches the computer and saves a PNG | FAIL · viewer timed out | FAIL · browser timed out |
| An active member outside the shared chat is refused with zero pixels | PASS · [Browser](run-2/fresh-shared-non-participant-1280.png) | PASS · [Browser](run-2/fresh-shared-non-participant-390.png) |
| A signed-in outsider without silo membership is refused with zero pixels | PASS · [Browser](run-2/fresh-shared-outsider-1280.png) | PASS · [Browser](run-2/fresh-shared-outsider-390.png) |
| Removal closes the socket and clears the picture within 2 s in the core journey | PASS · [181 ms](run-2/core-removal-1280.png) | PASS · [470 ms](run-2/core-removal-390.png) |
| Removal closes an open view in the shared chat | NOT RUN | NOT RUN |

The personal screenshots reopened from the chat and the session panel after
reload. Both downloads matched their saved digests. Both refusal identities
received HTTP 403 for view and capture at both widths. Each browser opened
zero desktop sockets and showed zero desktop canvases. Refused access to a
saved shared PNG was **NOT RUN** because shared capture timed out.

At 1280 px the shared reader could read the chat and the server issued a view
ticket. The viewer waited 20 seconds for **Viewing**, and the server recorded
no WebSocket upgrade for that ticket. The reader saw the access-lost screen
after reopening the chat for the removal check. The shared viewer never
opened during the removal checks. [Reader after reopening](run-2/shared-reader-reopen-1280.png)

The first browser command ended after the 390 px shared capture timeout.
The remaining checks continued on the same stack. Startup and service logs
were saved before teardown. [Measured results](run-2/results.json)

## Fresh journey run 1 on 26 November 2026

**NOT RUN** on source commit `f71ef74e82d36ee61df277ca21a6b98edc027854`.
The planned environment was a fresh slot 1 dev stack, Chromium and the free
stand-in provider.

At 19:43 UTC the slot and load checks reached the required five-minute
window. Another checkout claimed slot 1 before this checkout could acquire
it. Polling continued until the startup window closed. The slot checks are
recorded in `gate-poll.log`.

| Expected result | 1280 px | 390 px |
| --- | --- | --- |
| The member sees their personal desktop, saves a PNG and reopens it | NOT RUN | NOT RUN |
| The shared-chat reader sees the desktop, saves a PNG and reopens it | NOT RUN | NOT RUN |
| A non-participant is refused and receives zero desktop pixels | NOT RUN | NOT RUN |
| Participant removal closes the socket and clears the picture within 2 s | NOT RUN | NOT RUN |

Fresh startup, the browser drivers and teardown were **NOT RUN**.

## Earlier qualification

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

The failed attempt's startup and service logs were kept before teardown.
