<!-- One PR per whole feature. Small fixes go into the feature they belong to. -->

## Functional outcome

What a person or operator can now do, in plain words.

| Situation | Behaviour |
| --- | --- |
|  |  |

## Architecture

```mermaid
sequenceDiagram
```

- Components, streams, events and projections involved
- Contracts and patterns this sets (event-only truth, conditional append, ordering, trust boundaries)
- Event-catalogue changes, if any

## Evidence

- Tests and what each proves
- Gates: lint, typecheck, check:events, test (counts), web build and tests; CI
- Independent review: model, passes, verdict

## Not in this PR

- Deferred work, owner decisions, NOT RUN items
