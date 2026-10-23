# Folding-paper loader

This folder provides the folding-paper animation shown while the assistant is working. It gives a visible sign of activity without claiming how much work is complete.

## What it is responsible for

- Draws three coloured paper wings folding around a centre triangle.
- Repeats the animation while the calling page shows it.
- Shows a still folded shape when reduced motion is requested.
- Hides the decorative shape from screen readers so the surrounding page can explain the status once.

## Main files

| File | What it does |
| --- | --- |
| `fold-loader.ts` | Defines the reusable loading component and paper shapes. |
| `fold-loader.css` | Colours, positions and animates the shapes. |

## How it connects

This is part of [shared controls](../README.md).
The [chat workspace](../../chat/README.md) shows it during replies;
the [status example page](../../shared-state/README.md) also displays it.
The surrounding text supplies the meaning. The loader makes no server requests and
cannot tell whether work has succeeded.
