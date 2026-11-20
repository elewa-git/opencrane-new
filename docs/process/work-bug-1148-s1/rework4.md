# Long-conversation decisions: fourth fix round

Date: 20 November 2026 UTC. Branch: `work/bug-1148-s1`.
Builder's own checks only. The PR remains a draft.

Journey on a fresh dev stack: FAIL

## Scope and limits

Owner option A authorises 500 earlier messages for the live proof, each with its
completion event. The journey requests that count from the existing event seeder.
Its default remains 3,000 for the unchanged source regression. No assertion,
deadline, resource limit, product code or event contract changed.

This is slice one of one and fix round four of four. The owner increased the ticket
limit to 17 agent-hours, with 14.8 already used. Work began at 06:32 UTC; the two-hour
reporting boundary is 08:32 UTC. The first fresh attempt failed in CORE. No further
attempt or code fix was started. The remaining work in this round records the failure,
pushes the receipt and observes CI within that boundary.

## Own source checks

| Check | Result |
| --- | --- |
| Unchanged real-NATS seed regression | PASS: both cases; still requires all 3,000 messages, 3,000 completions, 300 bounded batches and the final completion checkpoint |
| Full typecheck | PASS |
| Typed ESLint on both changed driver files | PASS, no warnings |
| Events | PASS, 174 types |
| Knip | PASS, two existing configuration hints |
| Changelog | PASS; the existing branch release note remains in place |
| Markdown | PASS, repeated for this receipt before push |
| Public privacy and secret scans | PASS before push |
| Fresh CORE at source `2b54bfa1a` | FAIL at 390 px during live-view reply; 1280 px NOT RUN |
| Focused long-chat approval and Stop proof | NOT RUN: CORE failed first |
| Follow-up journey at source `85e52f13c` | FAIL at 390 px before live viewing; see the [follow-up receipt](journey.md#follow-up-fresh-attempt) |
| Hosted CI for this round | NOT RUN at receipt commit; see the PR check rollup for the pushed head |
| Local full root suite and paid-provider qualification | NOT RUN |

The starting head `3935b4059` had green
[CI run 44661786297](https://github.com/elewa-git/opencrane-new/actions/runs/44661786297).
The source change is committed as `2b54bfa1a`; the later receipt commit changes only
documents and captured evidence.
The 3,000-message case remains covered by the existing source tests; the real-NATS
fixture regression passed in this round with its original assertions. The live
500-message case still exceeds the unchanged 64-position read cap, but was NOT RUN.

## Fresh-stack admission and result

The [availability samples](availability-round4.csv) begin at 06:33 UTC and end at
08:06 UTC. Earlier intervals reset when load reached six or a secondary slot no
longer reported free. A status read returned non-zero during the earlier wait;
subsequent samples treat unavailable status as busy and reset the interval.
The successful interval lasted 300 seconds, from 08:01:48 to 08:06:49 UTC, with both
slots free and no package stack running. The final sampled load was 3.43.

Receipt `live-20261120T080649Z` claimed slot 1 and started `up.sh --fresh` at
08:07 UTC, testing `2b54bfa1a`. The other slot remained free after the claim.
CORE completed the 390 px chat, reload, Stop and upload assertions, then failed in
`browserLiveViewJourney` at `infra/dev-stack/browser-live-view.ts:158:64`:

```text
locator.waitFor: Timeout 30000ms exceeded.
Call log:
  - waiting for getByRole('article', { name: 'Agent reply', exact: true }).nth(3).getByText('Done', { exact: true }) to be visible
```

The browser also reported `net::ERR_FAILED` and three `net::ERR_ABORTED` transport
failures. The [current failure capture](round4-core-failure-390.png) shows Viewing.
The cause is not established. A saved host sample at 08:14:32 records one-minute
load 6.57; another observation during CORE was 13.45. Neither proves causation.
The 1280 px CORE and every focused long-chat condition remain NOT RUN. The TLS
launcher, 500-message event seed, approval, returned tool result, exact-byte checks,
one use, reload and post-Stop 403 were never reached.

The [journey receipt](journey.md) distinguishes this failure from earlier attempts.
Startup, service, container and pod logs, the failure and current screenshots were
retained in the private fleet receipt before `down.sh`. Slot 1 reported free at
08:15 UTC. A later run failed in the basic mobile chat before reaching live viewing;
the follow-up receipt records it. No source code or assertion changed. The free
stand-in provider was used. Paid calls: zero.
