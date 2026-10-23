# Stop with real model replies

Date: 23 October 2026. Part of #610, for the 26 October demo.

Source: `e872e3fe3`. Failing-test commit: `99cdf8b0b`.

## Cause and event order

Original rehearsal diagnosis: PARTIAL. The original rehearsal slot had been removed. Its retained report and pictures
show “Reply failed” with 175 characters kept, but contain no terminal reason or
computer log. The original turn's exact cause cannot be recovered from those files. The shared
node retains only the current slot's pod logs, so no older computer log remains there.

The runner removed model access before asking Codex to interrupt. Removing access
closes the active model connection. If Codex reports `failed` in that interval,
the old runner saved `model_error`, despite having already received Stop. The page
correctly displayed that saved reason as a failure.

The regression reproduces this order through the real runner, report journal,
NATS event store, report writer and browser transcript:

1. Start the reply and save some text.
2. Save Stop and deliver it to the runner.
3. Remove model access; receive a failed terminal report before `turn/interrupt`.
4. Save and replay the terminal report, then read the transcript again.

Before the fix, the test saved `model_error` and displayed “Reply failed”. With the
fix it saves `stop_interrupted`, keeps the text and displays a stopped reply.
The reverse-order case receives the model failure before Stop, but delays saving
its report until after Stop. It still displays a failure. This proves that saved
Stop order alone does not erase an earlier failure. A restart before Stop reaches
the runner also keeps `bridge_restarted` and its failure label.

The runner now remembers delivered Stop before removing access. Subsequent failure
or completion keeps that outcome. Tool refusals and computer-wide stop checks keep
their existing behaviour. No event names, API fields, access checks or dependencies
changed.

## Image and environment

Claimed secondary slot 1, origin `http://127.0.0.1:25106`. The owner stack was untouched.
The baseline was removed and the corrected stack started fresh.

The corrected image is
`k3d-ocn-registry:5000/opencrane/computer@sha256:ddbd61e7b3efd8d78a46e53611e332a11cfe110d844a6bd5a277f9bd3a8b6e21`.
It adds only the corrected `turn-runner.ts` to the previously reviewed runtime
`sha256:40e715076ce0c19f0610b0fbe7872112c971d50a444487126f4465b3d8d4c3f0`.
The OS, installed packages and their licences are unchanged. The image contents
check passed, including source equality, protected paths and absence of credentials.
The sandbox template pins the corrected digest.

## Checks

All lint, typecheck and test commands used `nice -n 10`. No full root suite ran.
Tests used `PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`;
these focused tests start their own NATS and do not need PostgreSQL projections.

| Check | Result |
| --- | --- |
| Clean `npm ci`; shared NATS and Lychee tool symlinks | PASS |
| Failing-first regression | PASS: 2 expected failures, 17 passes before the fix |
| Focused tests, final run 1 | PASS: 54 tests |
| Focused tests, final run 2 | PASS: 54 tests |
| Event security rules | PASS: 438 tests |
| Event catalogue | PASS: 149 types agree |
| Knip | PASS |
| Changelog | PASS |
| Lint | PASS |
| Typecheck | PASS |

The focused run covers `turn-model`, `turn-stop`, `bridge-gate`, `recovery-stop`
and `tool-reports`. Its first expanded run found one old assertion expecting
completion after Stop. That assertion now requires exactly one stopped ending;
both final runs pass. The protected authority tests and event security rules were
not edited.

## Live checks

Real provider configuration used only the authorised credential file path.
No credential values were read into diagnostics. Pictures mask credentials and
email addresses. Event extracts contain identifiers, times, types and reasons only.

The unmodified image passed fresh startup and a 390px smoke. Its Stop report was
`stop_interrupted`; that run did not reproduce the intermittent failure.
The failing integration test above is the deterministic reproduction.

Corrected fresh startup: PASS, including streamed real replies, Stop and reload.
All four running computers reported the corrected image digest.

| 390px attempt | Whole smoke | Stop and reload | Duration | Picture |
| --- | --- | --- | --- | --- |
| 1 | PASS | PASS: stopped, text kept | 88.691 seconds | [Stop 1](stop-1-390.png) |
| 2 | PASS | PASS: stopped, text kept | 100.451 seconds | [Stop 2](stop-2-390.png) |
| 3 | PASS | PASS: stopped, text kept | 95.211 seconds | [Stop 3](stop-3-390.png) |

Each attempt passed streaming/reload, PDF preview/download, Stop/reload, direct
message delivery, shared reply and budget refusal/restoration. The three saved
Stop endings all have `stop_interrupted`. A read-only connection to each computer
also observed Codex's terminal status: all three were `interrupted`. These live
runs passed the requested behaviour but did not exercise the failed-stream race;
the failing-first test is the evidence for that order.

See [timings](timings.json), [saved Stop events](stop-events.json) and
[spending](spending.json). The separate ten-step demo script was NOT RUN.

The phone runner reuses `demo-smoke-run.ts` and `demoBrowser` with widths
`[390, 390, 390]` and separate picture folders. Each smoke retains the existing
180-second deadline, Stop/reload assertion and all other smoke steps.

Baseline spending was 21 charged cents plus 33 held cents: 54 cents.
The corrected fresh stack has a 246-cent ceiling, leaving the combined task
within its 300-cent allowance even if every remaining hold is charged.
The corrected stack finished at 31 charged cents plus 70 held cents. Combined:
52 charged cents + 103 held cents = **155/300 cents**. Both corrected-stack ceilings
were restored to 246 cents; no saved restoration file remained.

The first image upload attempt used HTTPS against the local HTTP registry and
failed before the corrected computers could start. Uploading through the existing
registry forwarder fixed it without changing Docker settings. Startup then passed.

Cleanup: PASS. Slot 1 was released after copying its receipts. The read-only
terminal observers and temporary registry forwarder were stopped.

Private command logs and retained receipts: `/tmp/demo-stop-real-evidence/`.
