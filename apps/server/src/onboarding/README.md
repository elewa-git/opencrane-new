# Onboarding

This folder saves a member's welcome survey and lets them continue it after reloading the website. Answers stay private and encrypted, and completing a step does not start an assistant or spend money.

## What it is responsible for

- Reads confirmed progress from the member's saved history.
- Saves each of the four steps only after the preceding step is confirmed.
- Clears later current answers when an earlier answer changes.
- Restarts the survey without deleting its encrypted history.
- Checks membership of groups selected in the survey.
- Returns the original saved confirmation when a reply is lost.

Reads check current membership after loading, before opening private answers. Writes finish history loading before the short access check. Each accepted request saves one record. Changed retries and competing edits are refused; an uncertain save stays unknown until its original result can be read. These requests use the member's personal encryption keys rather than conversation keys.

## Main files

| File | What it does |
| --- | --- |
| [routes.ts](routes.ts) | Serves progress, step saves, restarts and original change results. |
| [commands.ts](commands.ts) | Checks step order, selected groups and repeated requests before saving. |
| [history.ts](history.ts) | Reads survey history and opens authorised encrypted answers. |

## How it connects

The [server](../../README.md) registers these requests for the [website](../../../web/README.md). [Members](../members/README.md) checks who is asking; [chat access helpers](../chat/README.md) supply membership checks without starting a chat. Shared [event rules](../../../../libs/events/README.md) define the saved answers. The personal key directory must already be prepared by background workers.
