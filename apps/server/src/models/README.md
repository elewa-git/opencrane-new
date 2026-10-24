# Models

This folder lets owners and admins choose who may use each AI model. It serves the access lists, offers suitable people, groups and assistants, and saves one access change at a time.

## What it is responsible for

- Returns bounded saved effect records separately from current effect state.
- Returns bounded call spending pages to current owners and admins, optionally by original UTC month.
- Lists recorded model access and suitable recipients from the same customer installation.
- Gives or revokes one [grant](../../../../GLOSSARY.md#grant), a saved permission for a person, group or assistant.
- Checks the original request when a save reply is lost.
- Reports read-table progress separately from permission progress.
- Registers neighbouring requests for remote tool access and outside destination rules.

Admins can revoke a departed person's grant. Revoking access that is already absent saves no change. A repeated request cannot report a different or unsaved change as saved. Provider choices and configured uses remain unavailable where the necessary records do not exist. These lists describe saved access; they do not approve an individual AI call.

## Main files

| File | What it does |
| --- | --- |
| [access-routes.ts](access-routes.ts) | Registers model, tool-access and destination requests and checks organisation access. |
| [spending-effects.ts](spending-effects.ts) | Reads saved effect records and checks current finance access. |
| [spending.ts](spending.ts) | Reads call spending and checks current finance access. |
| [access-changes.ts](access-changes.ts) | Saves model grants and recovers their original results. |

## How it connects

The [server](../../README.md) registers these requests. [Providers](../providers/README.md) manages provider accounts and model choices. [Integrations](../integrations/README.md) owns tool access; [egress](../egress/README.md) owns destination changes. Shared [models code](../../../../libs/models/README.md) checks AI calls and spending.

## Not done here

The running models process starts in [models-main.ts](../models-main.ts), outside this folder. It starts the AI gateway and checks each call against permissions, tool rules and budgets.
