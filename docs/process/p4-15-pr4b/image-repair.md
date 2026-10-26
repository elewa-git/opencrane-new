# Computer image startup repair

Date: 26 October 2026. Part of #97, PR #737.
Rebased base: `6c23803f1f33ceaa61e6c51e3cac2f36a691c89f`.
Failing-first test commit: `caea9abbe`.

## Finding and fix

The computer proxy imported the main `@opencrane/models` entry point. The image
did not contain that entry point or its server dependencies. Its bridge therefore
could not start, and supervisor fixtures timed out waiting for the health endpoint.

The proxy now imports `@opencrane/models/private-callers`. The Dockerfile copies
that module beside the existing routing module, and the package exports it directly.
The dependency check recognises this specific public entry point. The server and
computer still use one caller registry. Its source is byte-for-byte unchanged from
`562ea9ede`; it imports only Node's built-in crypto module.

The new image regression starts the packaged proxy without checkout mounts and
requires an exact 401 response for an unauthenticated request. Existing assertions,
caller bindings, access rules, memory restrictions and money checks are unchanged.

## Environment

Local worktree `<checkout>`, Node 22.23.3 and the existing Docker
daemon. The CI bake file builds a disposable computer image from its public pins.
The separate tag `ocn-upload-computer:p4-15-pr4b-fix` avoids replacing the shared
fixture image. Tests use disposable containers, with no owner-stack changes or
secondary development stack. This is not a fresh product installation.

Built image:
`sha256:d4cb30249bfab05f37197c59f84822ade13a7b24bf5ffd751aebc0a1ece6b048`.
The packaged proxy and caller module hashes match this checkout.
All test runs use `PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`.
These selected tests do not include projection or root-suite database tests.
Build, test, lint and typecheck commands run under `nice -n 10`.
Local logs are retained in `/tmp/p4-15-pr4b-fix/`.

## Own checks

- PASS: fetched origin, rebased onto the base above, confirmed it is an ancestor,
  and confirmed no rebase remains in progress. Documentation conflicts retain both
  main's routine-session restrictions and this PR's recall contracts.
- PASS: CI image bake before and after the fix.
- FAIL, expected: the new packaged-proxy test failed with `ERR_MODULE_NOT_FOUND`
  for `/app/node_modules/@opencrane/models/src/index.ts`. The first reproduction
  selected both supervisor files with `--bail=1`; it stopped at this new failure.
- FAIL, expected: a second reproduction selected the existing worker-launch
  refusal and unreadable-gate cases. Both failed with
  `Timed out waiting for service outcome`. The test was committed before the fix.
- PASS twice: all five requested files, 158/158 on each run. The current files have
  7 supervisor identity, 11 supervisor stop, 63 personal recall, 28 private proxy
  and 49 MCP proxy cases. Both runs include the new packaged-proxy test.
- PASS once: unchanged event-security rules, 438/438.
- PASS: full workspace and infrastructure typecheck.
- PASS: `check:events`, with 154 event types matching the catalogue.
- PASS: every lint stage, including Knip, documentation, links, fixtures, licences
  and `lint:changelog`. ESLint reported 28 warnings and zero errors.
- FAIL, corrected: the initial `npm run lint` stopped at the documentation stage
  because this receipt included an absolute home-directory path. It now uses a
  placeholder. The documentation stage and every remaining lint stage passed on
  rerun; the already-passing code, dependency and Knip checks were not repeated.

The image build command is:

```sh
nice -n 10 docker buildx bake -f apps/computer/test/upload-bake.hcl --load \
  --set computer.tags=ocn-upload-computer:p4-15-pr4b-fix
```

With the image and database variables above exported, both complete test runs use:

```sh
nice -n 10 npm test -- \
  apps/computer/test/supervisor-identity.test.ts \
  apps/computer/test/supervisor-stop.test.ts \
  apps/server/test/personal-recall-tools.test.ts \
  apps/computer/test/private-proxy.test.ts \
  apps/computer/test/mcp-proxy.test.ts --maxWorkers=2 --reporter=verbose
nice -n 10 npm test -- libs/events/test/security-rules.test.ts --maxWorkers=2
```

The event-security command runs once. CI's Angular warm-up is unnecessary for these
selected files, which do not start a web app. No full root suite was run.

## Remaining qualification

NOT RUN: image publication or promotion, fresh-install journeys, gVisor and native
private recall qualification. Production private memory stays disabled. The earlier
broader memory regression failures remain recorded in [the original receipt](receipt.md);
this repair does not claim to rerun those tests. CI is not awaited after the push.
