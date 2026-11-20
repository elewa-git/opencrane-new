# Fresh CORE journey

Journey on a fresh dev stack: PASS

Date: 20 November 2026. Tested source:
`e2ef2851051d2edf7bf3a4f7c1a81b1e301c68a3`.
Environment: secondary slot 1, fresh local data, Node 22.23.3, stand-in model
and real sign-in in the OpenCrane 2 Dev organisation. Paid-provider qualification
is NOT RUN.

## Corrected default CORE

Both slots were free, no package stack was running and one-minute load stayed
below 6 for five minutes before the claim. Checks ran every 30 seconds. The
[claim observation](logs/round-two-core-default-eligibility-at-claim.json) and
[observations](logs/round-two-eligibility.jsonl) retain these checks.

The default CORE journey inside `up.sh --fresh --id 1` completed successfully.
Its [complete startup log](logs/round-two-default-initial-core-default-up.txt)
records the following checks:

- PASS: real browser sign-in and chat at 1280 and 390 px, including Stop and a
  retained partial reply, uploads, preview and saved spending ceilings.
- PASS: over-ceiling stub calls are refused and remain refused after reload.
- PASS: members and MCP catalogue replay verification, with their existing
  60-second command limits unchanged.
- PASS: loopback web page and listeners, ID-token privacy in browser responses
  and process logs, form sign-out and credential-required reauthentication.

The two chat captures were copied before teardown and visually inspected for
private data. They show the expected reply and stopped partial reply.

| Viewport | Capture |
| --- | --- |
| 1280 × 900 | [Desktop](screenshots/core-default-1280.png) |
| 390 × 844 | [Mobile](screenshots/core-default-390.png) |

The runner used the requested commands, with the existing key supplied by path
only and without the optional `P4_JOURNEY_ATTEMPT` setting:

```sh
stack_id=$(infra/dev-stack/claim.sh) || exit 1
export DEV_STACK_ID="$stack_id"
export ZITADEL_KEY_FILE="<existing-key-file>"
nice -n 10 infra/dev-stack/up.sh --fresh --id "$stack_id"
infra/dev-stack/status.sh --id "$stack_id"
nice -n 10 infra/dev-stack/journey.sh --id "$stack_id"
infra/dev-stack/down.sh --id "$stack_id"
```

The explicit repeat through `journey.sh --id 1` is PARTIAL: it started after the
completed default CORE run and was interrupted at the task cutoff. It is not
counted as a second passing journey. [The workflow result](logs/round-two-default-result.txt)
records the command outcomes. All startup and service logs and screenshots were
preserved before `down.sh --id 1`; teardown is PASS. Full private captures were
retained outside the public repository. Only the inspected images above and
sanitised logs are published.

## Earlier extended attempt

The first fresh attempt is FAIL. The runner set `P4_JOURNEY_ATTEMPT` to name
captures, which also enabled optional Phase 4 qualification outside the requested
CORE scope. That was a runner mistake. Artifact names were separated from product
settings before the corrected fresh attempt.

That run captured 86 screenshots. Its [Phase 4 receipt](logs/round-two-extended-browser-receipt.json)
has 39 PASS rows, one paid-provider NOT RUN and one NOT PROVEN for separate member
disks and browser profiles. None of those untested conditions is counted as passed.
Members replay verification then reached its existing 60-second command limit:
[the saved error](logs/round-two-extended-last-error.txt) records `code: null`,
`killed: true` and `signal: SIGTERM`. Why replay could not finish within that
limit remains unproved. No assertion, product rule or replay timeout was changed.
Logs and screenshots were preserved before successful teardown.

The [checks receipt](checks.md) retains the native-budget failure and incomplete
full server package gate. The PR remains draft with those gates unresolved.
