# Fresh organisation journey

## What this is

This folder records what the organisation journey does in a real browser. It uses a claimed
secondary stack and a local model stub, so it makes no paid provider calls. The stack keeps
receipts and screenshots in its private directory while a run is in progress.

## Where it fits

The journey is process evidence. It checks the website, server and event store together.

```mermaid
flowchart LR
  process["docs/process<br/>work records"] --> journey["p4-journey<br/>browser evidence"]
  stack["infra/dev-stack<br/>local services"] -->|starts| journey
  journey -->|opens| web["apps/web<br/>website"]
  journey -->|checks saved changes| events["Event store<br/>saved history"]
```

## What it is responsible for

- Check groups, member removal, shared assistants, direct chats and provider key saving.
- Save each result and its screenshots after the run has finished.
- Mark results that need an Owner account or a paid provider call honestly.

## Processes it handles

1. **A secondary stack opens.** The owner and member sign in through Zitadel in separate browser
   sessions. The browser checks the organisation pages at 1280px and 390px.
2. **The results are recorded.** The journey checks what the server saved and what each person can
   see. The model stub counts requests during the direct chat.
3. **A repeat run checks saved data.** It uses new names and conversations, so old records do not
   stand in for the current run.

## How to run or test it

Claim a secondary stack with `infra/dev-stack/claim.sh`, then start it with
`P4_JOURNEY_ATTEMPT=fresh-1 infra/dev-stack/up.sh --fresh`. The named journey runs during
startup after real browser sign-in. Use a new attempt name for each run. The daily fresh run
does not set this name, so it does not run this journey. The dev stack guide describes the claim
and release commands.

## Receipt

No live result is recorded yet. Each saved receipt will name the clean commit that ran and link to
screenshots copied from that stack's private directory after qualification.

`NOT PROVEN` means the browser could not establish the result. `PAID / NOT RUN` means no paid
provider call was made.
