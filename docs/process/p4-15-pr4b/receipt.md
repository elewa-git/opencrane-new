# Restricted personal recall tool list

Date: 26 October 2026. Part of #97. Base: `d45dd860c`.
Test commits: `c02bf2a7d`, `b27acdf74`, `7a9e1edb6`.

This is the server assembly part of the requested native forwarding work.
The full path also needs the trusted launch integration left pending by PR 4a,
private thread loading, tool notification checks and native gateway fixtures.
Those form a separate change to keep this first part within the 600-line target.
This receipt proves source behaviour only. Production memory stays disabled.

## Prerequisites

The following changes were already merged into this worktree's base:

- Recall, #299: `19e4c01c6`.
- Reference evidence, #386: `627ce64cb`.
- Preparation, #525: `b5540ba23`.
- Output protection, #710: `7235079d9`.
- Private termination, #722: `12ca064d74866818c81a296046f4703e69fe306d`.
- Private proxy binding, #731: `419553ae68ab931b6f5e6673660e7fe536b7f525`.

The prerequisite reports describe pending launch wiring and private live delivery.
This change keeps those limits. It does not claim that the proxy registration API
is connected to a private process.

## Own checks

- PASS: clean `npm ci`; NATS and Lychee linked from the requested checkout.
- FAIL, expected: against unchanged production, 38 new assembly cases fail because
  the helper is absent; the production-disabled control passes.
- Setup corrections: the first test run imported the JSON helper from the wrong
  entry point. The first green attempt used `assistant` instead of
  `assistant_notes` for the notes scope. Both fixture mistakes were corrected.
- PASS: 49 assembly tests twice, including the existing ordinary-tool cases.
- PASS: 438 unchanged event-security tests once.
- PASS: event catalogue (154 types), Knip and changelog checks.
- PASS: full workspace and infrastructure typecheck.
- PASS: full lint, including dependency, documentation, link, fixture, licence
  and changelog checks. ESLint reports 26 warnings and zero errors.

Tests use `nice -n 10`, one worker and the supplied `PG_TEST_URL`. These assembly
and event-schema tests need no database or service fixture. No root suite, stack,
paid call or owner service is used.

## What the checks cover

The assembler requires the exact built-in recall definition and saved review,
zero-cent Allow, the built-in connection and server details, publication and both
MCP use grants. It refuses changed or duplicate recall entries, missing definitions,
Ask/Block, other scopes and another silo. The byte-boundary test checks the existing
120 KiB combined-frame limit. The shared builder retains the 48 KiB tool limit.
Existing ordinary-tool tests remain part of the selected checks.

No event or public API field is added. Internal `silo` and `scopeId` reuse existing
names and do not match the exact `RISKY_FIELD_NAME` expression. The event-security
file and both protected authority test files are unchanged. The helper reads no
conversation history and appends no event. Call deadlines and access streams are
unchanged. No dependency, secret handling or logging path is added.

## Remaining work

PARTIAL: server assembly only. Native memory delivery stays disabled without an
environment bypass. The helper does not authorise calls or establish turn identity.

NOT RUN in this part: pinned-Codex discovery/recall through the private proxy and
gateway, original capability expiry, header forgery and backend bypass, thread and
generation mismatch, stale grants, evidence-before-result, zero-result/four-call/
64 KiB/32-reference limits, lost replies, correction/forget during calls, late-output
refusal and native filesystem/external-tool termination. Existing handler checks
are not claimed as new native evidence.

NOT RUN: computer image build, check or promotion, fresh installation, gVisor and
disk inspection. No computer source or image pin changes in this part. Fresh
per-process callers, loading, volatile output and native tests remain follow-up
work before production offering can be enabled.
