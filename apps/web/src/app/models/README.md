# Models and providers

This folder shows Models & providers, where owners and admins connect companies that run AI models. They can save a connection key, check it, choose models and control who may use them.

## What it is responsible for

- Lists provider connections and their dated saved facts at `/org/models`.
- Creates connections and saves or replaces keys without reading a stored key back.
- Separates reachability checks from a paid model-answer test. Each paid test needs fresh consent for its quoted cost; an unknown result keeps further tests locked.
- Selects OpenAI models and shows the jobs using each model and the people, groups or assistants allowed to use it. Model selection is unavailable for Anthropic; Next continues without saving models.
- Grants or removes access for one person, group or assistant at a time. A grant is explicit permission; setup uses the same editor for each selected model.
- Reports confirmed setup changes separately from pending ones. Saved model choices and unresolved access changes keep their required checks available.
- Warns when a shared assistant lacks its own model grant only after a complete check. Missing or still-updating information stays unchecked.

The access editor loads more people, groups or assistants when requested. An uncertain
save keeps its original request reference for status checks, including after reload.
Saved models stay selected: removing one requires a check of its existing uses and
a separate review. Failed or unavailable checks cannot allow removal. Pending access
changes keep setup open so the person can still check their original requests.

## Main files

| File | What it does |
| --- | --- |
| `model-registry.*`, `provider-setup.css` | Draw provider setup, checks, model choices and key replacement. |
| `provider-page-state.ts`, `provider-key-changes.ts`, `provider-api.ts`, `provider-display.ts` | Read providers, keep pending changes and format saved facts. |
| `model-access-editor.*` | Choose an audience, change one permission and check its result. |
| `provider-setup-access.*`, `model-table.*` | Show setup outcomes and current model uses and access. |

## How it connects

[Organisation](../organisation/README.md) supplies navigation, and [Spending](../spending/README.md)
handles budgets. [Integrations](../integrations/README.md) supplies fact cards.
[The server](../../../../server/README.md) stores keys and performs checks and permission changes.
Access-request references can survive reload without storing names; access loss clears them
and protected page details. [Detailed notes](../../../README.robot.md#model-access-editor)
explain confirmation and paging limits.
