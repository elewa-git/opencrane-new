# Shared controls

This folder supplies the menus, dialogs and visual details used across the website. It keeps common interactions consistent, including keyboard focus and layouts for phones.

## What it is responsible for

- Opens dialogs, keeps keyboard focus inside them and returns focus when they close.
- Provides side drawers, modal sheets and phone navigation menus.
- Draws the brand mark, paper backgrounds, folded corners and completion effects.
- Shows loading animations and honours the browser's reduced-motion setting.

## Main files

| File | What it does |
| --- | --- |
| `overlay.ts`, `overlay.css`, `overlay-panel.html` | Manage shared dialog behaviour and layout. |
| `hinge-drawer.*`, `modal-sheet.*`, `navigation-menu.*` | Provide review drawers, sheets and menus. |
| `brand-mark.ts`, `paper.ts`, `shell.css` | Draw the brand and shared paper and page styles. |
| `flutter-loader.ts`, `grain-loader.ts` | Show assistant activity and loading placeholders. |
| [fold-loader](fold-loader/README.md) | Draw the folding-paper loading animation. |

## How it connects

[Chat](../chat/README.md), [organisation navigation](../organisation/README.md),
[personal settings](../settings/README.md) and admin pages reuse these controls.
[Status messages](../shared-state/README.md) provide the words that explain progress.
The shared controls do not read or save product data.
