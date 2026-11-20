# Packaged host preflight journey

Journey on a fresh dev stack: **PASS** for the packaged install and browser checks.

Tested source: `09ce627f5078a657fa96dcd2b86faca14e9c2cac`.
The [CI run](https://github.com/elewa-git/opencrane-new/actions/runs/44670687068),
[application image run](https://github.com/elewa-git/opencrane-new/actions/runs/44672461220)
and [scanner image run](https://github.com/elewa-git/opencrane-new/actions/runs/44672465350)
all completed successfully for that source before the packaged journey. The
installer fetched the two image approvals itself and checked their source and
success; the operator did not approve either image.

## Fresh packaged run

1. Recorded five continuous minutes below load six with both secondary slots
   free and no packaged stack. Rechecked the slots and load, then claimed slot 1.
2. `package-prepare` fetched the approvals and prepared a new package namespace.
   Private secret preparation passed after correcting an invocation that supplied
   the values file twice. The first invocation made no secret changes.
3. `package-up` without the override exited one. Its output named F1 and F2 and
   gave the exact repair instructions for the k3d node and underlying host.
   Helm had not started.
4. `package-up` with the one-command `accepted-dev-box-366` override printed
   `HOST RISK OVERRIDE` and every accepted F1/F2 refusal. The install record saved
   the override and both checked hosts before Helm. Helm reported deployed,
   and `package-check` passed. The override acknowledged the dev-box risk; it
   changed no host setting.
5. On the loopback forwarder, the browser signed in, completed a stub-model chat
   turn and refused unauthenticated history at both 1280 px and 390 px. Four
   screenshots were saved. The 390 px chat screenshot was also inspected.
6. Copied the screenshots, command output, install record, pod status, events,
   Helm status and service logs to private fleet receipt `run-20261120-0428`
   before teardown. `package-down` and `down.sh` exited zero, and slot 1 was free.

The private receipt contains account and service details, so it is not stored
in this public repository. No key contents were printed or placed in a command
argument. The browser screenshots were retained in that receipt.

## Earlier approval failure and correction

The first fresh attempt on source `4e637fef0e1024dbbf42e411cb79b22cbe10e0be`
failed during preparation, before host probes. Its
[diagnostic record](logs/approval-diagnostic.json) shows that GitHub's workflow
listing returned no run with `status=success`, although a query without that
filter found the successful exact-source run. A failing fixture reproduced this
response. The approval lookup now filters the returned runs locally and still
requires the exact source, successful conclusion and bound image evidence.
The earlier [preparation log](logs/package-prepare.log) and
[cleanup record](logs/cleanup.json) remain retained.

## Limits

The accepted local override does not qualify production-node F1/F2 protection.
Live production-node probes and fault/disk qualification are **NOT RUN**. The
separate fresh core-stack check is recorded below.

## Fresh core stack

The separate `up.sh --fresh` check also **PASSED**. After another five-minute
exclusive resource window, the operator claimed slot 1 and started the fresh
core stack. Its built-in integration journey passed browser sign-in, upload,
chat, live view, audit and budget checks at both 390 px and 1280 px. The
workspace screenshot at 1280 px was inspected. Ten screenshots, startup output
and 16 service logs were copied to private fleet receipt `core-20261120-0441`
before `down.sh`. Teardown exited zero and the slot was free.

## Behaviour-preserving review fixes

Journey rerun: **NOT RUN**, as authorised for these review fixes. The source diff
`d52da1d372080e71bee0ea7b7656505547da72fa..700007b4d394e0ac2e7eca3e48d052a357bffc9c`
strengthens fixtures, adds internal typed refusal reasons, names parsing steps
and simplifies the package diagram. Installer decisions, operator output,
commands and record contents are unchanged. The packaged and core journeys above
remain **PASS** on their recorded source. No secondary stack was claimed for
these fixes. See the [fix receipt](round-two.md) for tests and mutation evidence.
