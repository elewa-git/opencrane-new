# Packaged journey binding

Part of #15. This is the first source part of P5-11, under D08/D10/D11.
Overall: PARTIAL. No live install was run for this change.

## What runs

`infra/package/journey-entry.ts` repeats the existing fresh package runner twice
on one claimed k3d cluster. Each run uses a new namespace and fresh storage.
The cluster is reused; these are not separate clusters.
Each install starts with empty event and projection
state. The existing checks require a verified owner and distinct install ids,
PVC UIDs and OpenFGA stores. Namespace and release UIDs must also differ.
The browser collector runs before its loopback forward and package are removed.
It signs in, completes a stub chat and requests that conversation's history from
a separate browser context with no session. Only HTTP 401 and the exact public
refusal body are accepted. It repeats these checks at 1280 and 390 pixels.

Each result requires a clean source worktree and records its git revision and server image checked
against the Deployment, checked context, namespace and release UIDs, install time and id,
PVC and PV UIDs, OpenFGA store and loopback origin. This records the runner source and
image separately; it does not prove the image was built from that revision.
Screenshots go into the claimed slot's private directory, under the install id.
The final private `package-journey.json` says PARTIAL and lists only executed checks.
A failed collector prevents a receipt and run two, even if cleanup also fails.
Stage B receipts or old screenshots cannot replace this fixed collector's output.

## Later live command

This command is recorded for the later qualification owner. It was NOT RUN here.
`PRIVATE_VALUES_FILE` and `ZITADEL_KEY_FILE` name private files, never their contents.
The claimed slot needs its existing test sign-in app and verified owner account.
Preparation uses the existing read-only provider path.

```sh
DEV_STACK_ID=$(infra/dev-stack/claim.sh) || exit 1
export DEV_STACK_ID
infra/dev-stack/run.sh target-up --id "$DEV_STACK_ID"
nice -n 10 node --experimental-strip-types infra/package/journey-entry.ts "$PRIVATE_VALUES_FILE"
infra/dev-stack/down.sh --id "$DEV_STACK_ID"
```

Live blockers: the dedicated target helper does not install the registry,
computer runtime or other product prerequisites. Reviewed image availability,
private connection settings and working stub computers must be established in
the claimed target before this command can qualify chat. Three-peer NATS remains
refused by the ordinary installer. No owner stack or host networking changes are
authorised by this receipt.

## Checks and limits

Source checks are recorded below after execution. Harness fixtures use disposable
files and fake cluster replies. They do not qualify a live product install.
Full P3-22, real Odoo and OAuth, full P5-10, P5-12, native memory, routines and
full P4-28 remain NOT RUN. Full P4-28 belongs to P5-13. Fresh-dev Stage B evidence
from #641 is historical input, not packaged evidence.

Shared helpers are on main: #720 at `599d4261d67362938df73cea7efdac36d3fc40f7`
and #724 at `5d66d23bb1d68be847f53aa9a5b53fa998b0ad75`.
The earlier twice-fresh package journey is #514 at `0b116876f`;
fresh-dev Stage B is #641 at `105071aaa`. Their reports were read before building.

Own source checks, 26 October 2026:

- PASS: expected failing tests committed before implementation.
- PASS: 100 package tests twice and 38 claim and fresh-install tests twice,
  with `PG_TEST_URL` set and `nice -n 10`.
- PASS: full typecheck, event catalogue, knip and changelog lint.
- NOT RUN: root test suite, live installs, live browser qualification and paid models.
- PASS: full lint, including dependency, documentation, licence and changelog checks.
