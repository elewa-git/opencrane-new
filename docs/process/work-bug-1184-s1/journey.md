# Packaged desktop viewing

Journey on a fresh dev stack: PASS

## Fresh main package

**FAIL** on `6d9444cbe` at 1280 and 390 px. Sign in, open a saved conversation
and choose **Watch your computer**. Both ticket POSTs returned 200. Chromium
raised a constructor `TypeError` in `startViewer` at each width, and both sockets
closed before the first frame.

The server accepted the session, Origin and ticket on both requests, recorded
both start audits, then recorded `disconnected`. One upgrade reached its
WebSocket connection callback. The production noVNC import exposed a CommonJS
wrapper where the viewer expected a constructor.

[1280 px Disconnected](main-disconnected-1280.png) ·
[390 px Disconnected](main-disconnected-390.png)

## Fresh fixed package

**PASS** on `a793705f4762d7e2f3458f307246798624a07fb7`. The package ran with
the exact approved application and scanner images.
[CI](https://github.com/elewa-git/opencrane-new/actions/runs/45438006198) ·
[Application approval](https://github.com/elewa-git/opencrane-new/actions/runs/45438000659) ·
[Scanner approval](https://github.com/elewa-git/opencrane-new/actions/runs/45438008961)

1. Sign in and open a saved assistant conversation at each width. At 390 px,
   open **Session panel**.
2. Choose **Watch your computer** before giving the desktop grant. The viewer
   shows **Unavailable** and has no canvas.
3. Give the test desktop grant and reopen the viewer. The ticketed WebSocket
   returns 101 and the browser decodes a frame with the fixture window in an
   800 × 600 canvas.
4. Revoke the grant while the viewer is open. It shows **Access changed** and
   removes the canvas.

| Viewport | No grant | Decoded desktop | Revoked |
| --- | --- | --- | --- |
| 1280 px | [Unavailable](package-no-grant-1280.png) | [Viewing](package-decoded-1280.png) | [Access changed](package-revoked-1280.png) |
| 390 px | [Unavailable](package-no-grant-390.png) | [Viewing](package-decoded-390.png) | [Access changed](package-revoked-390.png) |

The server recorded a first browser frame and an `access_changed` stop for
each fixed-package view. The main and fixed installs used distinct namespaces
and installation IDs.
Both package starts used the logged dev-box host-risk switch
`OPENCRANE_ACCEPT_DEV_HOST_RISK=accepted-dev-box-366`. The failure-log check
found no file before package teardown. Service logs were collected and each
slot claim was released.

## Fresh CORE

**PASS** on the same product commit. The secondary stack started fresh and
CORE used real sign-in, a saved conversation and the deployed desktop at
both widths. The browser showed **Unavailable** before the grant, decoded
800 × 600 frames after the grant and cleared them on revocation. The revocations
produced `access_changed` stop audits. The remaining CORE checks and the
explicit CORE repeat passed, and the stack was released after collection.

| Viewport | Decoded desktop | Revoked |
| --- | --- | --- |
| 1280 px | [Viewing](dev-viewer-1280.png) | [Access changed](dev-revoked-1280.png) |
| 390 px | [Viewing](dev-viewer-390.png) | [Access changed](dev-revoked-390.png) |

## Source checks

- **PASS**. Before the fix, the browser regression failed with **Disconnected**
  where it expected **Viewing** in the open dialog. After the fix, all five
  Chromium tests passed twice. The regression requires a decoded red test pixel
  at both widths.
- **PASS**. All 19 server admission and refusal tests passed twice, including
  anonymous POST and WebSocket attempts with zero event writes, and exactly one
  audit per valid-session refusal with a missing or hostile Origin.
- **PASS**. Web unit tests (1,605) and the production build. The changed
  viewer unit test also passed its repeat.
- **PASS**. Typecheck, event catalogue (174 event types), Knip, changelog lint,
  changed-file ESLint, Markdown lint, public privacy check and secret scan.
