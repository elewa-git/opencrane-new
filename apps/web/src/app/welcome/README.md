# Welcome survey and persona review

## What this is

This folder shows the welcome survey and creates a private persona from its four
saved answers. People can review the text and approve that exact saved version.

## Where it fits

These screens are part of the website. The server supplies saved survey answers,
persona versions and approval results.

```mermaid
flowchart LR
  web["apps/web<br/>personal screens"] -->|opens| welcome["welcome<br/>survey, creation and review"]
  welcome -->|reads, creates and saves| server["apps/server<br/>private onboarding"]
  welcome -.->|uses| state["shared-state<br/>status messages"]
```

## What it is responsible for

- Show four saved survey steps and let people continue from their confirmed answers.
- Create the first persona after the survey, then read and show its private text
  only after access checks.
- Approve the exact current version and check an uncertain approval by its command id.
- Show when approval was saved and link to the workspace afterwards.
- Clear private text when access ends.
- Not built yet: persona editing, replacement and survey restart from the review screen.

## Processes it handles

1. **Survey.** A person saves each answer. The screen reads progress again before
   moving on. The completed survey links to persona review.
2. **Persona review.** The screen reads progress, the current version list and that
   version's text. If there is no version yet, it asks the server to create one
   from the saved answers. It checks an uncertain creation without sending it again.
   A competing edit makes the screen read the latest version again.
3. **Approval.** The screen sends one command. If the result is uncertain, it checks
   that same command. Confirmed approval shows the saved time and opens the workspace.

## How to run or test it

Run `npm test -w apps/web -- --watch=false --include='**/persona-review.spec.ts'`
for the focused review tests. Run `npm run build -w apps/web` to build the site.
The exact capture command is in [README.robot.md](README.robot.md).

## Where to read more

[README.robot.md](README.robot.md) records the HTTP and state details.
[The server onboarding folder](../../../../server/src/onboarding/README.md)
describes where the private answers are saved.
