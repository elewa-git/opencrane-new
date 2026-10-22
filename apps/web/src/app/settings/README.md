# Personal settings

This folder shows the Account page and the menu for personal settings. People can check their signed-in name and continue an unfinished welcome survey.

## What it is responsible for

- Reads the current sign-in session and shows its name as read-only.
- Distinguishes an expired session, a failed read and a missing name.
- Checks survey progress before offering Continue welcome survey.
- Provides desktop navigation and a phone menu for Account, Preferences, Assistant and My tools.

## Main files

| File | What it does |
| --- | --- |
| `account-screen.*` | Read and display the signed-in identity and survey link. |
| `personal-settings-shell.*` | Draw personal settings navigation and the page area. |
| `pages.ts` | Names personal settings pages and their addresses. |

## How it connects

[Page selection](../README.md) opens these pages under `/account`.
[Welcome](../welcome/README.md) owns the survey; [shared controls](../ui/README.md)
supply the menu. [The server](../../../../server/README.md) supplies identity and progress.

## Not done here

Preferences, Assistant persona review and My tools show unavailable messages.
The Account page does not yet show email, organisation, role, groups or an editable preferred name.
