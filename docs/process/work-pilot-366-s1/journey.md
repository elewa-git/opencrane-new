# Packaged host preflight journey

Journey on a fresh dev stack: FAIL

Tested source: `4e637fef0e1024dbbf42e411cb79b22cbe10e0be`.
The fresh packaged attempt stopped in `package-prepare`, before host probes,
Helm, application startup or browser access. It is not qualified for merge.

## Steps observed

1. Waited for both secondary slots to be free, no packaged stack to be present,
   and the one-minute load to stay below six for five minutes. The
   [resource samples](logs/resource-window.json) record the qualifying window.
2. Claimed fresh secondary slot 2 at 01:44 UTC on 20 November 2026.
3. Ran `run.sh package-prepare --id 2`. It refused with
   [this startup output](logs/package-prepare.log).
4. Copied startup output, pod status, events, service logs and the install
   record before teardown. No package pods or events existed; their saved logs
   are empty. The [install record](logs/host-install-record.json) contains no
   host-preflight result because preparation failed first.
5. Ran `package-down --id 2` and `down.sh --id 2`. Both exited zero;
   [cleanup results](logs/cleanup.json) also show successful log retention.
   Verified that slot 2 was free afterwards.

## Failure

The exact-source application approval lookup refused at its metadata stage.
The successful [application workflow](https://github.com/elewa-git/opencrane-new/actions/runs/44640305759)
and [scanner workflow](https://github.com/elewa-git/opencrane-new/actions/runs/44640305395)
both name the tested source. Direct application-run lookup reports completed
and successful. However, the existing approval guard's GitHub workflow query,
including `status=success`, returned no matching run. An exact-source query
without that status filter returned the successful run. The
[diagnostic record](logs/approval-diagnostic.json) records those observations;
it does not establish why GitHub returned different results. The approval
guard was retained without bypasses, retries or relaxed acceptance checks.

## Host checks and remaining qualification

The read-only local `node infra/package/preflight.mjs --host` exited one and
reported both F1 and F2 with their exact fixes. See
[the host refusal](logs/local-host-refusal.log). No host setting was changed.
Fixture tests separately cover each refusal, every target node, local node
identity, explicit override logging and saving the override in the install
record before Helm. See [own checks](checks.md).

The packaged refusal without an override, successful install with the explicit
override, `package-check`, and browser steps at 1280 px and 390 px are **NOT RUN**:
preparation failed before they could start. No screenshots were produced.
The additional fresh core-stack journey is **NOT RUN** for the same reason.
Live production-node F1/F2 qualification is **NOT RUN**. The accepted dev-box
exception does not qualify production disk protection.
