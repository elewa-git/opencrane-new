# Native recall answer checker

7 November 2026. Part of #97. Branch `work/p4-15-pr5t2`.
Base: `cdc0be1a3` after fetching and fast-forwarding main, including merged 5u.
Tested implementation: `f0a5679ce72fe3907d7b0abd4a122cd9511fa6a2`.
Environment: disposable local services, not a fresh installation. No image was built.

## Scope

PARTIAL. This is the bounded local checker split. It compares completed native
notifications with a stored fact in RAM and requires its exact saved reference.
It binds deployment and requester identities and refuses stale state without retry.
The scripted peer exercises the production JSON-RPC decoder. The backend test uses
real disposable services and the reference observation made before recall delivery.
Neither test is a real model answer or proof of native requester isolation.

The shipped journey remains NOT RUN and every receipt remains incomplete.
The measured deployment driver, actual native model execution and live Correct/Forget
and isolation remain NOT RUN. Fresh-install execution belongs to 5i4.
Admission, scanner paths, native write loaders and dev-stack files are unchanged.
No new event/API field, dependency or private-text hash is introduced.
No protected authority or security test is changed.

## Own checks

- PASS: fetched main, fast-forwarded the worktree, ran npm ci and linked both tools.
- PASS: failing-first commit `20f48942d`; all 33 cases failed before implementation.
- PASS: the three focused recall files passed twice, 49 checks each. Commands used
  the qualification Vitest config, one worker and nice -n 10. The backend used a
  throwaway PostgreSQL container and its assigned port; container and volume removed.
- PASS: collector deployment/result tests, 97 checks, including copied receipts.
- PASS: unchanged event security test, 460 checks, with the requested PG_TEST_URL.
- PASS: event catalogue, 158 matching event types; local qualification typecheck.
- PASS: focused lint after replacing unsafe assertions with validated parsing.
- PASS: workspace typechecking and changelog validation.
- PARTIAL at draft preparation: the full lint run read the earlier versions of four
  errors already fixed above. Its rerun uses the committed source. The PR evidence
  and final report record that rerun and pushed-head CI results.
- NOT RUN: fresh-install qualification, live isolation and complete private memory.

No owner stack or host settings were touched. Paid model calls cost 0 euro cents.
