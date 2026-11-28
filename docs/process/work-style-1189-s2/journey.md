# Development stack style check

Journey on a fresh dev stack: NOT RUN

The source changes are being checked before the slot is claimed. This receipt
will record the fresh CORE journey, selected pictures and source check results.
The work changes readability only. Existing refusal checks remain in place.

## Scope

The [scope list](scope.json) records the date window, changed source files and
files left for another part. Files shared with the open scanner refresh, pilot
update and tool journey pull requests are excluded.

The audit and spending journeys now have named steps. Related audit identities
and budget identities use named input types. The spending checks share their
existing scope lookup. Host probes and secret-store setup keep the same checks
and command order. The small upload helpers keep their original wait and retry
rules. No dependency, event or product API name changes.

## Source checks

The original host, audit, sign-in, spending and upload checks passed before their
refactors. This change has no new behaviour to reproduce with a failing test.
The test changes only pass the same budget identities through a named input.

The first supplemental lint run found four existing functions with more than
five parameters. Grouping their related audit and budget inputs removed those
findings. The repository ESLint configuration excludes infrastructure; a local
configuration also checks the changed helper modules with TypeScript rules,
80-line functions, five parameters, complexity 15, depth four and 500-line files.
The large existing CORE driver has only its call arguments changed, with no
increase in its line count.

One attempted unit-test command included `provider-journey.test.mjs`, which is a
live packaged browser driver. It refused the unclaimed slot before a journey.
It is excluded from unit-test commands. The required live check is CORE.

Raw command output stays on the box. No independent review is claimed here.
