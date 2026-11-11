# Checked routine result and finish

## What changed

The internal fixture now follows one saved due through the checked send, a scripted
native start, a saved company response, a rooted model settlement and the native
closure. The finish command saves one result reference and one terminal event.
It refuses a response saved before the company Allow decision.

## Limits

The production delivery switch is off. The fixture uses disposable services and a
scripted peer. It does not prove a paid company call or a fresh install.

## Own checks

- PASS: the response-before-decision test failed before the ordering correction.
  The seven new sender cases then passed twice with one worker and disposable
  PostgreSQL, NATS and OpenFGA. A final run after the added replay assertion
  passed seven of seven again.
- PASS: the finish and event security files passed 497 tests. The event
  catalogue check, changed-file ESLint, repository typecheck, Knip,
  changelog lint, Markdown lint and privacy scan passed.
- PARTIAL: six selected hand-off and Stop cases passed. The unchanged lost-due
  case failed once while acquiring the routine leader lock, then passed when
  run alone. This does not make its first failure a pass.
- NOT RUN: the root suite, a paid company call and a fresh-install journey.
  No dev stack was started.
