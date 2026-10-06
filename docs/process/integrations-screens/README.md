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
| INT-37 | Detail actions | “Manage tools” and “Check discovery status” replace “Manage access” and “More”. The API has no access editor or extra menu yet. |
| INT-37 | Detail facts | Connected and Allowed for say “Not available yet” because those reads do not exist. The Last connection check and Used by sections are not shown. Available says “Not available yet” for a published server because access grants cannot be read. |
| INT-03 | Row actions | There is no “Set up connection” action because connection profiles are not built. |
| INT-94 | Access lost | “Back to workspace” replaces “Go to Overview” because the Overview page is not built. “Your Admin role was changed at 09:14” is omitted because the server supplies no role-change time. |
| INT-07 | Refresh | One “Refresh list” control stays in the header so focus does not move. |
| INT-06 | Detail facts | No people, team names, actor names or invented times appear. |
| INT-06 | Installed fact | The server's own status appears, such as “Needs input · Pending review”, instead of “Draft · Not published”. “Your saved choices stay in this draft” is omitted because saved tool choices are not available to this screen. |
| INT-03 | Register status | Status uses the labels sent by the server, such as “Ready”, instead of “Available to the assistant”. The API does not report the frame's assistant availability label. |
| INT-04 | Register status | Status uses the labels sent by the server, such as “Needs input”, instead of “Draft — review not finished”. The “Review changes” row is not shown because the API has no tools-changed state. |
| INT-06 | Detail refresh | The current facts stay visible, and a status message reports the refresh result. |
| INT-10 | Source choices | Catalogue and package choices say “Not available yet”. No catalogue listing is shown because neither route exists. |
| INT-10 | Add flow steps | Steps have numbers and labels, without check marks, because the API gives no completion evidence. Connection and Publish say “Not available yet”. |
| INT-30 | Tool actions | Each tool has its own Save button in place of “Review access”. The API saves one mode at a time and has no review or grant command. |
| INT-30 | Tool details | No tool descriptions are shown because the policy response has no description field. |
| INT-30 | Tool Save | “Save” applies a mode only when the server has a validation connection. The API rejects a missing connection id. |
| INT-31 | Access summary | “Nobody can use these tools yet” replaces the frame's access claim because publishing and grants are not available. The Audience section says “Not available yet” in place of people chips and “Review access”. |
| INT-93 | Conflict notice | The notice names no person or time. The conflict response supplies neither, and can also come from a lagging read. |
| INT-96 | Matching status read | “Saved policy matches your change” replaces “Confirmed: applied”. A later read cannot show which command made the modes match. |
| INT-96 | Status result | There is no “Not applied” result because the API has no per-command status read. |
| INT-90 | Invalid save | “Reload tools” replaces “Try again”. The same invalid input would fail again. |

## Checks

| Check | Result | Evidence |
| --- | --- | --- |
| Root lint | PASS | All lint steps passed. ESLint reported six warnings in unchanged files. |
| Workspace typecheck | PASS | TypeScript passed in every workspace. |
| Angular production build | PASS | The build completed. It reported stylesheet budget warnings and the existing noVNC CommonJS warning. |
| Angular web tests | PASS | 315 tests passed across 32 files. |
| Event catalogue check | PASS | All 96 event types match the catalogue. |
| Server integrations tests | PASS | All 21 tests passed, including the browser refresh journey. |
| Integrations screen check | PASS | 118 captures at 1280, 390 and 320px with both motion settings. It checks retry and loading states, tab counts, one failure message, the full-row link hit target and access-link text colour. |
| Foundation screen checks | PASS | 56 captures, states, register, keyboard and reduced motion. |
| Drawer and focus checks | PASS | 38 captures, focus, navigation and reduced motion. |
| Organisation shell checks | PASS | 22 captures, navigation, routes and screen moves. |
| Settings screen checks | PASS | 20 captures, shell, routes and phone menu. |
| Workspace screen checks | PASS | 18 captures at 1280, 390 and 320px with reduced motion. |
| Regression mutation checks | PASS | The new refresh, focus, failed-count, single-message and availability assertions failed when their guards were removed. The row hit test failed when the Server cell became its positioned parent. All guards were restored. |
| Full root test suite | NOT RUN | The task asked not to run the full root suite. |
| Dev-stack journey | NOT RUN | No journey was requested. |
| Fresh-install qualification | NOT RUN | This screen change does not qualify a fresh installation. |

The visual record has 118 PNG captures. They are evidence and are not part of the source line count.

The server does not yet publish integrations, read grants, mark tools as reviewed, remove
servers or provide connection profiles. The screen work is therefore partial.

## PR B checks (2026-10-06)

| Check | Result | Evidence |
| --- | --- | --- |
| `nice -n 10 npm run lint` | PASS | No errors. ESLint reported seven existing max-lines warnings. |
| `nice -n 10 npm run typecheck` | PASS | TypeScript passed in every workspace. |
| `nice -n 10 npm run build -w apps/web` | PASS | The build completed with existing stylesheet budget and noVNC CommonJS warnings. |
| `nice -n 10 npm run test -w apps/web -- --watch=false` | PASS | 331 tests passed across 34 files. |
| `nice -n 10 npm run check:events` | PASS | All 96 event types match the catalogue. |
| `nice -n 10 npm test -- apps/server/test/integrations.test.ts` | PASS | All 21 integrations tests passed. |
| `nice -n 10 npm run visual:integrations` | PASS | 178 captures at 1280, 390 and 320px with both motion settings. It checks phone controls, keyboard movement, row hit targets and GET-only status checks. |
| `nice -n 10 npm run visual:f1-foundation` | PASS | 56 captures and foundation screen checks. |
| `nice -n 10 npm run visual:f2-drawers` | PASS | 38 captures and drawer and focus checks. |
| `nice -n 10 npm run visual:f3-org-shell` | PASS | 22 captures and organisation shell checks. |
| `nice -n 10 npm run visual:f4-settings` | PASS | 20 captures and settings checks. |
| `nice -n 10 npm run visual:f5-workspace` | PASS | 18 captures and workspace checks. |
| Guard-removal checks | PASS | The step marker, connection-required link and missing-connection guards each failed their spec when removed. All guards were restored. |
| Visual comparisons | PASS | Fixture replies cover the new states. No fresh-install journey was run. |
| Full root test suite | NOT RUN | The task asked not to run the full root suite. |
| Dev-stack journey | NOT RUN | No dev-stack journey was requested. |
| Fresh-install qualification | NOT RUN | This change does not qualify a fresh installation. |

This change adds the remote add flow and tool mode screen. Catalogue admission,
connection profiles, review marking, grants and publishing still need server support.
