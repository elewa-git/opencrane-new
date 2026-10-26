# Personal recall admission checks

Date: 26 October 2026. Part of #97. Result: PARTIAL.

This first part requires matching privacy evidence before the internal personal
recall builder returns a tool list. Production memory remains DISABLED. The
member journey is NOT RUN: the current server discards memory-bearing answers,
and private Codex launch and forwarding remain incomplete. This receipt is not
passing evidence for admission.

## Source and image

Base: `6cc9d0e87b9c1952e6115fc3d8349cf037f252ca`.
Failing-first test commit: `cab7d9928b898665e2357215ac1e4640b5c57c4a`.
Implementation source: `88968a1a17d98c51bbb70378148598357aa969ad`.
Later documentation edits do not change the tested application source.

The unchanged deployment template pins computer image
`sha256:ddbd61e7b3efd8d78a46e53611e332a11cfe110d844a6bd5a277f9bd3a8b6e21`.
This change neither builds nor promotes an image. The earlier
[image repair](../p4-15-pr4b/image-repair.md) tested a different local image,
`sha256:d4cb30249bfab05f37197c59f84822ade13a7b24bf5ffd751aebc0a1ece6b048`;
that is not qualification for this source or deployment image.

Prerequisite merges present in the base:

| Change | Merge |
| --- | --- |
| Human personal Memory journey, #685 | `f34ccba16` |
| Report persistence protection, #710 | `7235079d9` |
| Unavailable output acknowledgement, #715 | `955cfedca` |
| Private termination and connection loss, #722 | `12ca064d7` |
| Caller-bound proxy, #731 | `419553ae6` |
| Restricted recall assembly, #737 | `6cc9d0e87` |
| Install placement checks, #724 | `5d66d23bb` |
| Protected memory admission gate, #383 | `986b9f199` |

## What changed

The builder requires exact source, image and host identities plus all nine
passing check groups documented in the [server contract](../../../apps/server/README.robot.md#personal-recall-qualification-p4-15-pr-5a-first-part).
Missing or malformed evidence refuses before catalogue or permission reads.
The final check also rejects evidence or scope changes while assembly waits.
Saved requester, turn, thread, caller and generation checks remain required.
Only the exact reviewed, zero-cent Allow recall definition can be returned.
Other tools, scopes and ordinary execution receive no memory entry.

These values are internal deployment inputs. No route, environment toggle or
computer-provided qualification is added. The synthetic test evidence proves the
refusal decision only; it cannot qualify an image. Production calls the ordinary
builder, which still excludes memory, and still refuses tools on restricted turns.
`memory-admission.test.ts`, `security-rules.test.ts`, `authority.test.ts` and
`authority-volume.test.ts` are unchanged.

No event or API field is added. The exact `RISKY_FIELD_NAME` expression was checked:
new internal evidence fields do not carry content or credentials. No history,
access stream, two-second write limit, append path, money or dependency changes.

## Own checks

- PASS: clean `npm ci`; linked the existing NATS and Lychee tools. Package files unchanged.
- FAIL, expected: 26 tests failed and 68 passed before implementation. Missing,
  incomplete or mismatched qualification still returned a tool; delayed scope
  and evidence changes also returned a tool. Committed these tests before the fix.
- PASS: the first focused run after the fix, 105 tests across recall assembly,
  server tool assembly and the unchanged memory admission test.
- PASS: both complete selected regression runs, 184 tests each. The unchanged
  event-security suite passed once, 438 tests, alongside the first run (622 total).
- PASS: workspace, package and development-stack typecheck.
- PASS: event catalogue, 154 event types agree.
- PASS: ESLint (28 warnings, no errors), dependency checks and Knip.
- FAIL, corrected: the first lint command stopped at Markdown checking because
  the new server contract heading lacked a blank line. Added the blank line;
  no application or test code changed.
- PASS: documentation, README, links, fixtures, package licence and changelog
  checks after that correction. All stages of `npm run lint` passed; the already
  passing code, dependency and Knip stages were not repeated for a blank line.

Commands run under `nice -n 10`, with one Vitest worker and
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`.
These tests do not include projections or the full root suite. Normal local
proxy fixtures may open disposable listeners; no second daemon is started.

The selected regression command names these files explicitly:

```sh
nice -n 10 npm test -- \
  apps/server/test/personal-recall-tools.test.ts \
  apps/server/test/turn-tools.test.ts \
  apps/server/test/memory-admission.test.ts \
  apps/computer/test/turn-tools.test.ts \
  apps/computer/test/private-proxy.test.ts \
  apps/computer/test/mcp-proxy.test.ts --maxWorkers=1
```

The first run also names `libs/events/test/security-rules.test.ts`. Local command
logs use `/tmp/p4-15-pr5a-` followed by `red.log`, `green1.log`, `regression1.log`,
`regression2.log`, `typecheck.log`, `events.log`, `lint.log` and `lint-docs.log`.
Those logs are local
diagnostics, not live qualification receipts.

## Qualification blockers and resources

PASS: `claim.sh` returned slot 1 after the prerequisite work had released it.
`down.sh --id 1` released the unused claim. No stack, fresh installation,
browser, model call or paid request was started. Spend: 0 euro cents. No owner
stack or host network setting changed.

The first-part split is deliberate: producing a visible volatile answer still
requires requester-only server/browser delivery and checks immediately before
release. The current bridge saves only unavailable status for memory-bearing
answers. Automatic correction/forget/revoke invalidation remains incomplete.
The private runner starts without memory tools and refuses tool items. Server
assembly alone cannot complete or qualify this native path.

NOT RUN on this source/image: native recall through real gateway/OpenFGA; A/B
canaries; same requester in two sessions; revoke/correct/forget stopping work;
unrelated activity; Stop/reconnect; Pod replacement; browser reload loss;
live and attempted-persistence scans of PVCs, rollouts, caches, outbox, logs and
dumps; 1280px/390px captures. No direct HTTP substitute or tool-free proof is
claimed for any of these conditions.

The protected global gate requires both complete private-turn and private-memory
qualifications. This narrow recall check does not satisfy or weaken it. Group
and notes memory, pins/preferences, writes and full #97 remain NOT RUN. Full
P4-15 is not PASS. No CI result is claimed; the builder stops after opening the
draft PR.
