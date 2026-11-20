# Install hardening source checks

Source implementation: `32dc94d96`. Live qualification is
[NOT RUN](journey.md); source checks cannot qualify the capability.

## Test-first evidence

The observations below preceded the original implementation. The listed hashes
are the rebased test commits. During the rebase, the first chart test was also
seen failing for its missing token mount before the implementation was replayed.

- `292ecbbab`: the explicit public mode was unsupported, the chart did not mount
  a token and the owner bootstrap still attempted its development command.
  The targeted checks failed before the implementation.
- `d43b902f2`: the new hostname and explicit-choice tests exposed acceptance of an
  IP address and a string-valued chart switch. Both refused after the fix.
- `2d357da93`: removing the token record still let the installer succeed. The
  new refusal test failed with actual status 0 instead of 1 before the fix.
- Removing each of the six public sign-in requirements in isolated child-process
  module loads made its matching CLI refusal test fail with actual status 0.
  Removing the stored runtime and bootstrap-override checks likewise made both
  installer refusal tests fail. All eight probes detected the removed rule.
  These temporary changes never altered the checkout or other test processes.

The first broad package attempt exposed the existing VM fixture's inability to
require an ESM module with top-level await. The fixture now supplies the real
imported token reader; no product check, timeout or assertion was weakened.
An initial installer assertion expected the new organisation message, but the
existing required-field check refused first. The assertion now expects that
existing refusal. The first typecheck found an inferred map too narrow for the
development identity key; the preparation map now has its explicit text-record type.

## Completed checks

| Check | Result | Evidence |
| --- | --- | --- |
| Workspace, package and dev-stack typecheck | PASS | Final complete root command exited 0 |
| Complete rebased package scope, twice | PASS | 643/643 each; no skips; 770.56 s and 960.84 s |
| Token and bootstrap integration suites, twice | PASS | 58/58 each; 168.07 s and 136.83 s |
| Public-address focused CLI, chart and installer checks | PASS | 47/47 before the complete repeats |
| Event catalogue | PASS | 174 registered event types match the catalogue |
| Knip | PASS | Two existing configuration hints; no unused-code finding |
| Changelog | PASS | Branch release note; no changelog edit |
| Markdown | PASS | Complete configured Markdown scope, no file arguments |
| Package READMEs | PASS | Fixed structure and size checks |
| Whole-stream reads and lint debt | PASS | Existing reads unchanged; no raised limit |
| Scoped ESLint invocation | PASS | Repository configuration ignores infrastructure files |
| ESLint rules on infrastructure | NOT RUN | Infrastructure is excluded by the repository configuration |
| Web tests and build | NOT RUN | No website source changed |

All tests, typechecks and lint commands ran under `nice -n 10`. The Vitest runs
used the shared disposable database and at most two workers. No full root test
suite ran. Existing real NATS and Docker fixtures remained within the allowed test
scope. No secondary journey, owner stack, Docker daemon or host network was changed.

## Rebase

Main advanced to `c791103b3` while the first checks ran. The branch was rebased
onto it. Both sets of appended tests were retained; template and preparation
conflicts keep main's backup restore and removal of conversation-key storage.
The README diagram retains the restore process and stays within eight nodes.
The updated lockfile was installed with `npm ci` before restarting the gates.

Before that rebase, the same four package files passed 639/639 twice, and the
same four token/bootstrap files passed 58/58 twice. Those are historical results;
the completed-check table records the rebased runs. All eight guard removals were
repeated and detected on the rebased source too.

## Test commands

```sh
nice -n 10 node --experimental-strip-types --test --test-concurrency=2 \
  infra/package/preflight.test.mjs infra/package/chart.test.mjs \
  infra/package/chart-render.test.mjs infra/package/cnpg-install.test.mjs
nice -n 10 node --experimental-strip-types --test --test-concurrency=2 \
  infra/package/preflight.test.mjs infra/package/chart.test.mjs \
  infra/package/chart-render.test.mjs infra/package/cnpg-install.test.mjs
nice -n 10 npx vitest run infra/package/bootstrap.test.ts \
  apps/server/test/bootstrap-token.test.ts apps/server/test/bootstrap-claim.test.ts \
  apps/server/test/bootstrap-browser.test.ts --maxWorkers=2
nice -n 10 npm run typecheck
```

Run the Vitest command twice with `PG_TEST_URL` pointing at the shared disposable
test database. These are source checks, not the live journey commands.

## Make it right

One shared module owns exposure shape and production sign-in validation. Both
preflight and the saved Kubernetes settings use it. Only the two consumed guard
functions are exported, with an explicit TypeScript exposure shape.

Preparation reuses the server's token-record reader and claim route. It copies
only the hash record, removes development owner settings in the chosen mode and
keeps the server's existing event-only membership decision. No new event, product API,
SQL business rule, licence or dependency was added.

Named helpers separate sign-in preparation, required Secret fields and Secret
decoding. The dispatcher settings now use a clear loop. The test fixture's file
generator was split out. The replaced preflight exposure loop was removed.
Changed production functions have at most 60 counted lines and three parameters.
No size limit was changed and the new file-read error keeps its cause.

Shipped code: 253 added plus 34 deleted lines, 287 total. Tests, test fixtures,
documents, release notes and receipts are excluded.
