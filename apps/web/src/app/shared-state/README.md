# Status messages

This folder provides the status messages used across the website. People see words and symbols for progress, saved changes, failures and uncertain results, so colour is never the only clue.

## What it is responsible for

- Shows the calling page's explanation with a matching status symbol.
- Offers Check status for an unknown result and Try again only for a failure known to be safe to repeat.
- Shows saved check times, scheduled times and change references when supplied.
- Announces a message to screen readers when the calling page requests it.
- Displays example states and loading animations on a development-only example page.

## Main files

| File | What it does |
| --- | --- |
| `shared-state.*` | Draw the reusable message and choose permitted action labels. |
| `state-specimen.*` | Show example messages and paper effects at `/org/states`. |

## How it connects

[Page selection](../README.md) opens the example page, which is absent from normal navigation.
[Integrations](../integrations/README.md), [Spending](../spending/README.md) and other screens
supply real status and action handling. [UI controls](../ui/README.md) supply example animations.
These components display results; they make no server requests themselves.
