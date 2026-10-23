# Welcome survey

This folder shows the welcome survey after sign-in. People enter their name, describe their work and choose how they would like their assistant to help.

## What it is responsible for

- Opens `/welcome/survey` at the first unsaved step and shows saved progress.
- Collects a name, optional pronouns and a work description, with current groups shown as read-only context.
- Saves tone, answer length, citation preference, suggested tasks and an optional own task. These wishes install nothing and grant no access.
- Warns before editing earlier answers clears later ones or replaces saved group context.
- Checks recovered progress before saving a draft made during a failed read.
- Clears answers when sign-in or access ends and ignores older replies. Answers stay out of browser storage and addresses.

## Main files

| File | What it does |
| --- | --- |
| `survey.ts`, `survey.html`, `survey.css` | Coordinate steps, saves, recovery and completion. |
| `survey-name.ts` | Keep and check name and pronoun answers. |
| `survey-work.ts` | Read current groups and check work answers. |
| `survey-choices.ts` | Keep style and task choices and their keyboard behaviour. |

## How it connects

[Account](../settings/README.md) links to unfinished surveys.
[The server](../../../../server/README.md) supplies progress and saves answers.
[Status messages](../shared-state/README.md) explain saves and failures.
Completion links to the Assistant settings page, which currently says persona review is unavailable.
