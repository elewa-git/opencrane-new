# Integrations register and detail

The web app reads the organisation's integrations from the server. An admin can search the
register, open a server and see what the current API can prove. Missing connection and access
reads say “Not available yet”. The server still owns every saved change.

```mermaid
flowchart LR
  web[Web app] --> register[Register and detail]
  register --> server[Server API]
```

## Visual comparison

| Reference frame | Capture | What differs and why |
| --- | --- | --- |
| INT-03 | Register rows | There are no catalogue or package rows in the current register API. |
| INT-01 to INT-07 | Search | The labelled search sits below the tabs so the field has a visible name. It has no icon or placeholder. |
| INT-01 | Empty register | The empty message uses a plain panel without a dog-ear. |
| INT-03 | Tools column | The count says “on Allow or Ask” because the API counts modes, not grants. |
| INT-37 | Detail facts | Connected and Allowed for say “Not available yet” because those reads do not exist. |
| INT-03 | Row actions | There is no “Set up connection” action because connection profiles are not built. |
| INT-94 | Access lost | The page uses a grey card and a small primary “Back to workspace” link. |
| INT-07 | Refresh | One “Refresh list” control stays in the header so focus does not move. |
| INT-06 | Detail facts | No people, team names, actor names or invented times appear. |
| INT-06 | Detail refresh | The current facts stay visible, and a status message reports the refresh result. |

## Checks

| Check | Result | Evidence |
| --- | --- | --- |
| `nice -n 10 npm run lint` | PASS | All lint checks passed; ESLint reported six warnings in unchanged files. |
| `nice -n 10 npm run typecheck` | PASS | All workspaces passed. |
| `nice -n 10 npm run check:events` | PASS | All 96 event types match the catalogue. |
| `nice -n 10 npm run build -w apps/web` | PASS | Angular production build completed with CSS budget and CommonJS warnings. |
| `nice -n 10 npm run test -w apps/web -- --watch=false` | PASS | 270 tests passed across 30 files. |
| `PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres nice -n 10 npx vitest run apps/server/test/integrations.test.ts --maxWorkers=2` | PASS | All 21 server integration tests passed, including the browser refresh journey. |
| `PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres nice -n 10 npm test -- --maxWorkers=2` | PARTIAL | The first full run had 1,838 passed, 3 failed and 15 skipped. It found old screen assertions and a theme radius mismatch, which have since been fixed. The authority-volume test returned 403 under shared load. Targeted theme, authority and server integration checks later passed; the server integration file passed all 21 tests. A clean full rerun has not happened. |
| Visual F1 | PASS | 56 captures; updated the old register count and refresh-control assertions. |
| Visual F2 | PASS | 38 captures. |
| Visual F3 | PASS | 22 captures; navigation, routes and screen moves. |
| Visual F4 | PASS | 20 captures. |
| Visual F5 | PASS | 18 captures at 1280, 390 and 320px with reduced motion. |
| `nice -n 10 npm run visual:integrations` | PASS | 94 captures at 1280, 390 and 320px with both motion settings. The check covers failure and no-match states and checks desktop column alignment. |
| Dev-stack journey | NOT RUN | No secondary stack was requested. |
| Fresh-install qualification | NOT RUN | This screen change does not qualify a fresh installation. |

The visual record has 94 PNG captures. They are evidence and are not part of the source line count.

The server does not yet publish integrations, read grants, mark tools as reviewed, remove
servers or provide connection profiles. The screen work is therefore partial.
