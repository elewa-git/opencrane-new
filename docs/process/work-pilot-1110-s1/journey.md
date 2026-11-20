# Packaged connected-provider journey

Journey on a fresh secondary install: PARTIAL — startup passed; the complete
provider journey remains unqualified.

Date: 20 November 2026 UTC. The installed runtime source was `2eb0b9b4e`; its
product code is identical to `eacd06709`. Later changes affect the browser test
fixture and documentation. Application approval
[44672116271](https://github.com/elewa-git/opencrane-new/actions/runs/44672116271)
and scanner approval
[44672120365](https://github.com/elewa-git/opencrane-new/actions/runs/44672120365)
passed for that installed source. The branch was rebased on `origin/main` at
`c791103b3`; the rebase finished.
Receipt edits change no application code.
The paid-provider check is separate and NOT RUN. Paid calls: **0**; actual external
charges: **0 cents**. Only synthetic provider credentials were prepared. No
provider credential was entered before the invitation fixture failed.

## Live verdicts

| Condition | Result |
| --- | --- |
| Fresh packaged namespace, approved images and service startup | PASS |
| Owner sign-in through the shipped browser | PASS |
| Admin invitation in the first test fixture | FAIL: new member id was not a UUID |
| Corrected invitation fixture | NOT RUN after correction |
| Settings wrong-key refusal, right key, quoted test, selection and switch-on | NOT RUN |
| Member replies and screenshots at 1280 and 390 px | NOT RUN |
| Synthetic credential modes before and after Pod recreation | NOT RUN |
| Live credential disclosure checks | NOT RUN |
| Logs saved before teardown; all claims released | PASS |

The queue stopped at its two-hour waiting limit. Another secondary journey and
then host load above six prevented a new complete five-minute observation window.
The fleet marker, access checks, assertions and test timeouts stayed intact. The
source fixes are present, but the first two findings still need their live proof.
The failing browser result is retained in [live/result.json](live/result.json).
No screenshots were produced because the first failure preceded provider setup.

## Fresh install and browser steps

The task's fleet marker stayed present throughout. The installed package and
browser driver never set `DEV_REAL_PROVIDER`. The installed package ran provider mode with qualification enabled. The route
keeps ordinary Settings, custody, access, price consent, default selection and
switch-on admission; those browser steps remain NOT RUN here. Its configured upstream was
`model-qualification:43003`, a separate Deployment running `model-stub.ts`.
All other model upstreams and fallback key settings were refused by admission tests.
Unit checks verified HTTP 401 for an incorrect bearer credential; the live
wrong-key browser step remains NOT RUN.

Before the installation claim, both slots reported free, no package stack was up and
the one-minute load stayed below six for at least five minutes. Checks ran every
30 seconds. The owner stack was not used. An early unused claim followed an
unsuccessful 299-second check because the shell wrapper did not stop after the
assertion failed. That claim was released before services started. The wrapper
then used `set -euo pipefail`, and the installation claim followed a complete
361-second observation window. A later claim cross-check found the other
slot occupied; it refused to start services and released its unused claim. A new
complete window was required after that as well.

The packaged fresh-install path uses a new owned namespace and new PVCs, rather
than the Compose `up.sh --fresh` path. `package-prepare` refuses a live Compose
stack in the claimed slot. Commands, in order:

```sh
infra/dev-stack/claim.sh
# Export the returned secondary id as DEV_STACK_ID.
infra/dev-stack/run.sh package-prepare --id "$DEV_STACK_ID"
# Set models.mode=provider and models.qualification=true in private package values.
PACKAGE_SKIP_PROVIDER_SETUP=1 node --experimental-strip-types infra/package/prepare.ts
infra/dev-stack/run.sh package-up --id "$DEV_STACK_ID" --values "$PACKAGE_VALUES_FILE"
infra/dev-stack/run.sh package-check --id "$DEV_STACK_ID"
infra/package/forward.sh
node --experimental-strip-types infra/package/provider-journey.test.mjs
infra/dev-stack/run.sh package-down --id "$DEV_STACK_ID"
infra/dev-stack/down.sh --id "$DEV_STACK_ID"
```

Preparation fetched successful exact-source application and scanner approvals
from GitHub. Builders did not approve images. Test, preparation and startup
commands ran under `nice -n 10`. The runner opened real Chromium and signed in as
the owner through the shipped browser route. Its planned member steps use a
separate identity and personal, memory-free sessions. Neither those steps nor
private memory delivery are qualified here.

The first install started successfully but its browser test failed before provider
setup: the fixture supplied a label as a new member identifier. The invitation API
correctly refused it with HTTP 409 because a new invitation requires a UUID.
`c5bb3e8f7` records the failing journey; `eacd06709` supplies fresh UUIDs. Startup
and service logs were copied, with secrets and private addresses removed, before
teardown. This changed no membership or access rule.

## Source checks

PASS means the builder's own check passed. These fixtures do not replace the live
journey. No full root suite ran locally. Vitest used two workers and the shared
disposable test database; all tests and typechecks ran under `nice -n 10`.

- PASS: affected package render, preflight and installer suites twice, 359 and
  360 cases. Focused custody, destination, stub and launcher checks passed in a
  complete 276-case run. The final four isolation checks passed twice.
- PASS: affected server/managed-model runtime tests twice, 38 cases each, with
  disposable NATS, PostgreSQL, OpenFGA and the pinned gateway.
- PASS: models browser unit tests, 128 then 130 cases; the three new chat setup
  tests passed twice again after cleanup. The six changed Node checks also passed
  twice after cleanup.
- PASS: runtime build-context, copied fixture imports and narrow saved-image
  source admission checks twice. The context check used a normal Docker build.
  Exact-source CI application approval passed all 20 saved-image checks.
- PASS: complete default rendered bytes match the immutable main baseline under
  the same Helm binary. Both Helm 3 and Helm 4 passed twice. Changing a default
  workload annotation made the comparison fail.
- PASS: workspace typecheck, event catalogue (174 types), Knip, changelog, scoped
  ESLint, Markdown, README and lint-debt checks. Knip reported its two existing
  configuration hints. Infrastructure files remain excluded by the repository's
  ESLint configuration and are checked by their TypeScript projects.

One extra focused repeat hit the unchanged launcher deadline while the host load
was 28. Assertions and deadlines stayed unchanged; its isolated three-case repeat
passed. Earlier CI runs found missing runtime imports, omitted source paths in the
saved-image allowlist and a renderer-version-dependent hash. Each cause gained a
failing check before correction; approval and image checks were not relaxed.

Hosted CI for `eacd06709`: PASS, including all four test shards, source checks,
browser fixtures and image fixtures. Application and scanner approvals also passed.

## Findings, failing checks and cleanup

1. Private key remount: `3557f4d11` records the failing mode checks and
   `d29236da6` adds `OnRootMismatch` plus a startup check that repairs private modes
   before either application container starts. It refuses links and unexpected
   file types. Removing the mode repair made the test fail.
2. Packaged merge journey: `11891a853` records the missing restricted route and
   wrong-key rejection; `f43c3a4dc` records missing Settings switch-on controls.
   `8ec37ebc6` adds the separate free stand-in and uses the existing command APIs
   from Settings. Bypassing destination admission made its refusal test fail.
3. Backup isolation: `76847bdd9` records the skipped CronJob regression.
   `7fa01e9a9` walks all rendered Pod specifications, including CronJobs, and
   resolves container/init mounts to PVC claims. `a1671b1be` adds a same-name
   workload relocation regression; `2eb0b9b4e` checks the workload as well as the
   container. Adding an aliased provider PVC mount only to the real backup
   CronJob's init container made the rendered isolation check fail.

Cleaned the changed functions against the engineering table: kept one owner for
runtime settings and admission, used named command values, split decoding steps,
removed replaced logic, kept functions small and added no dependency or limit
exception. The provider key PVC remains excluded from backup and restore;
recovery policy is deferred to #15. No backup or monthly-budget live qualification
is claimed here.
