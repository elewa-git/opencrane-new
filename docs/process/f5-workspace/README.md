# F5 shared workspace pieces

Source receipt for issue #135 (parent #130), 5 October 2026, `work/f5-workspace`.
Visual references are in `/home/jente/dev/design-handoffs/v2/`.

## Scope and data

The transcript now uses `ToolActivityLine` for sanitised command results,
`ConversationFileCard` for authorised conversation file paths and
`BudgetStopNotice` for the recorded `budget_exhausted` decision. Tool details do
not offer a new-message retry. File open and download use the existing authorised
conversation file route, and the existing Files action opens the Session panel.
The budget stop says which scope, limit, reset time and
held amount are missing because the chat decision event does not provide them.

The existing F1 `SharedState`, F2 `HingeDrawer`, paper and loaders, and F3 shell
are reused. The workspace adds the handoff's empty-conversation and no-screenshots
states, and the phone composer places the message field above its toolbar. Approval
decisions remain in the existing `ApprovalCards` contract. The Session panel no
longer claims decision or people counts that its chat endpoints do not return.

Chromium captures use the repository's intercepted protocol fixtures. Their
display names and file text are test data, not production workspace content. The
product view is populated only from the current chat and file responses.

## Visual comparison

[`visual.json`](visual.json) lists all captures and browser checks. Captures cover
1280px and 390px with normal and reduced motion.

| Reference | Capture | Comparison |
| --- | --- | --- |
| WRK-01, desktop and phone | `empty-workspace-*` | Keeps the existing workspace rail/header and docked composer. The empty selected conversation uses a truthful “No messages yet” state; names, recipient text and sample messages from the frame are omitted. |
| WRK-80, desktop and phone | `empty-workspace-*`, `phone-panel-*` | Reuses the Session panel and native Files/Activity tabs. The Files view says “No screenshots yet” and points to the existing computer viewer. Existing watch and history controls remain. |
| WRK-01 tool line | `workspace-effects-*` | Reuses the transcript position and quiet disclosure. The component shows the recorded command result, generic provider availability and timestamp; no inferred retry or provider data is shown. |
| WRK-80 file card | `workspace-effects-*` | Uses the authorized file path and recorded turn time. Open and Download use the existing conversation file route. |
| WRK-40–45 and SPD-54 budget stop | `workspace-effects-*` | Matches the inline stop placement and shared blocked-state glyph. The actual chat event only supplies `budget_exhausted`, so scope, amount, reset date and held spend remain explicitly unavailable. |

The linked designs show example people, titles, dollar amounts and reset dates.
Those details are not represented as live values in the captures. The stop notice
is therefore a truthful adaptation, not an exact reproduction of those example
states.

## Source checks

| Check | Result | Evidence |
| --- | --- | --- |
| Lint | PASS | Repo-wide lint; seven existing ESLint warnings, no errors; dependencies, unused-code, Markdown, links and fixtures passed. |
| Typecheck | PASS | `npm run typecheck` across all workspaces. |
| Event catalogue | PASS | `npm run check:events`; all 89 event types agree on the rebased main. |
| Angular production build | PASS | `npm run build -w apps/web`; existing bundle/CSS budget and noVNC CommonJS warnings. |
| Angular tests | PASS | 19 files, 130 tests. The first rebased run timed out twice while source checks ran concurrently; the isolated full suite passed. |
| F1 visual check | PASS | 56 captures; shared states, phone targets, keyboard focus and reduced motion. |
| F2 visual check | PASS | 38 captures; restored the Files action and added the short valid lease required by the current live-view contract in the computer fixture. |
| F3 visual check | PASS | 22 captures; navigation, routes and screen moves. |
| F5 visual check | PASS | 10 Chromium captures; workspace states, keyboard tool disclosure, file actions, budget truth and phone panel checks. |
| Chat-browser journey | PASS | The root suite's budget-stop expectation was updated to assert the truthful missing-scope notice; `node scripts/check-chat-browser.mjs` passed. |
| Focused backend reruns | PASS | Five cases from the original base and both failures from the rebased root run passed alone. |
| Full root suite | PASS | Final rebased run: 1,605 passed / 15 skipped (102 files passed, 4 skipped); started at integer load 4. Two earlier timeouts during overlapping workspace runs passed alone before this clean full run. The pre-rebase root run also passed 1,569 tests. |
| Fresh-install live qualification | NOT RUN | Source capture uses intercepted fixtures; no live silo journey was requested. |
