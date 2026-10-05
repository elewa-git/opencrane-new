# Chat implementation and reuse

Issue [#30](https://github.com/elewa-git/opencrane-new/issues/30), parent
[#25](https://github.com/elewa-git/opencrane-new/issues/25). The original owner
handoff is [README.robot.md](README.robot.md); **Workspace Live** is the canonical screen.
The HTML and support script are preserved as design references, never bundled
into the app. Wireframe PNGs have been reduced from 2× to 1× with Chromium's
canvas encoder. The texture is the original embedded JPEG, extracted unchanged.

## Reuse assessment

OpenCrane 1 was cloned read-only into a scratch directory at `10abd0ef6`.
Its licence is AGPL-3.0-or-later, compatible with this repository's licence.
At this commit, the handoff's earlier module names have become `conversation-*`.

| Handoff name | Source at `10abd0ef6` | What was retained or rebuilt |
| --- | --- | --- |
| chat-thread | `libs/frontend/elements/conversation/.../conversation-message` and workspace transcript | Avatar/content/header structure and safe text interpolation retained; own bubble, bare Agent prose, citations and streaming rebuilt from the handoff |
| chat-composer | `libs/frontend/elements/conversation/.../conversation-composer` | Parent-owned draft and output events retained; native controls replace PrimeNG; Enter, Shift+Enter, IME, Stop and toolbar follow the handoff |
| chat-asset-panel | `libs/frontend/features/conversation-assets/.../asset-card` and `files-panel` | Type swatch, author/time and list anatomy retained in the handoff layout; old artifact service and upload state store excluded |
| tool-call-card | `libs/frontend/features/conversation-activity` | Old activity cards rejected; native expandable tool lines match Workspace Live |
| run-progress | workspace connection status and conversation status line | Glyph/words and live announcements retained conceptually; Fold, caret and wake state rebuilt for the bridge |
| workspace-shell | `conversation-workspace-page.component.scss` | Three-column grid, scroll region and docked composer retained; 236/300px widths, 56px header and mobile overlay follow the handoff |
| theme and UI elements | `libs/frontend/core/src/lib/theme` and `elements/ui` | Existing copied tokens/fonts reused; no PrimeNG dependency added; original paper texture and motion definitions taken from the owner's design |

Copied/adapted files identify the source commit in their headers. No old turn
protocol, activation queue, sagas, model loop, run-tree ledger, artifact service,
preprocessor or SQL business logic was imported.

Open Terminal `b58442aa8599755525878f917b621e0145b0e8f7` provides the single-view
preview design: workspace root, `preview=true`, original-byte fallback and a
preview pane with download. See [its MIT notice](OPEN-TERMINAL-LICENSE.txt).
That repository contains the backend contract; its integrated graphical client
is Open WebUI. No Open WebUI code or dependency was imported. Angular implements
the interaction with native dialog, image, PDF and text views.

The P2-3 bridge has no file-byte endpoint. The client requests the conversation's
`files/view?path=…&preview=true` seam and displays unavailable when it is absent.
Office conversion and the bounded, authorised byte relay are not implemented
by this change; live file previews therefore remain partial. No conversion runs
on the server or in the browser. The file
preview and attachment controls do not claim a successful file operation.

## Visual evidence

[Comparison page](comparison/index.html) shows all in-scope frames beside the
built UI at 1280px and 390px. Run `npm run visual:chat` to regenerate it with
Playwright Chromium. Protocol fixtures live only in the capture script, never
in the app. Screenshots use reduced motion to make comparison repeatable.

The reference has group/project examples, an approval card and participants;
this implementation only mounts personal Agent sessions. Projects and Archived
are empty until supported data exists. No fictitious unread counts or decisions
are stored locally. Rail titles/statuses derive from authorised event projections.
There is no group To-picker, participant picker, elicitation or A2UI renderer.
The fenced A2UI placeholder and attach menu are present.

Motion definitions cover the fourteen specified motions, with a maximum row
entrance chain of 1.74 seconds. Reduced motion removes animations and leaves the
caret solid. Native dialogs trap focus, close with Escape and restore the trigger.

## Review and visual fix round

The [visual fix list](visual-fix-list.md) records each disposition; the
[receipt](fix-round-evidence.md) records tests, screenshot inspection and gates.
The shared SVG set supplies control and state icons without an icon dependency.
Voice input is absent because it is unavailable. **Connectors are deferred**:
there is no scoped chat connector API, so the 1j menu and comparison caption
state that limitation. Groups, projects, ask cards and agent threads remain
outside issue #30. The Activity panel indexes recorded tool lines and run failures.
Provider responses and retries are marked unavailable when the bridge does not
supply them. The footer's member name is read from the authorised member
projection; team/department metadata is not supplied, so it shows personal scope.

Production CSS stays in external stylesheets (`inlineCritical: false`). The
serving layer must generate a fresh nonce per HTML response, put it on
`<app-root ngCspNonce="…">`, and include it in `style-src 'self' 'nonce-…'`.
Scripts require only `script-src 'self'`. The production Playwright harness
serves the real build with this enforcing policy and asserts no CSP violations.
Zod **4.6.5, MIT** was already bundled through the protocol package; it is now
an explicit web dependency to configure `jitless` before schemas are imported.
Its installed LICENSE was checked. No new package version or icon package was added.

The browser harness disables dependency prebundling so workspace protocol edits
are included in each qualification run. Live reload and HMR are disabled so an
editor change cannot interrupt an in-progress page assertion. Each invocation owns an ephemeral web
server. It never starts, stops or reconfigures the shared dev stack.
