# Accepted product decisions — 27 September 2026

> Copied verbatim from OpenCrane `plan.md` on branch `feat/conversational-routines` (commit `fadaf5c2f`, lines 3–59). These decisions carry into OpenCrane 2. "Historical evidence" refers to the original OpenCrane plan.

The user requested preservation of the administration design package during cleanup of the older
checkout. The [design brief](docs/design/administration-lifecycle/README.md),
[screenshot guide](docs/design/administration-lifecycle/screenshots.md),
[component handoff](docs/design/administration-lifecycle/components.md), and
[36 supplied wireframes](tests/design-targets/organisation-administration/README.md) are retained
with their original bytes and provenance. All 47 image checksums match their manifests. These
remain design references, not accepted visual baselines or proof of implemented functionality.
Their source assessment is pinned to `967f7c0b6`; reconcile current implementation and the later
accepted product decisions before building from the brief. Developer-tooling files are excluded
from this preservation commit. The latest database-boundary decision below is retained separately
from implementation and test claims.

## Accepted product decisions — 27 September 2026

The user has accepted the following decisions for the remaining MVP work. They are product
contracts, not claims that implementation or qualification is complete; the owning waves below
remain open until their source, focused tests, SQL tests and live qualification say otherwise.

- **Shared-work budget:** one paying group is selected when shared work is created or scheduled;
  children inherit that paying group. Spend contributes to the global ceiling, the paying group's
  ceiling and any optional assistant ceiling, with one charge recorded rather than duplicate
  attribution across those scopes. The exact reservation and usage owners must preserve the root
  allowance across retries, children and lost responses.
- **Budget policy:** limits are configured in EUR per calendar month, resetting at 00:00 UTC on the
  first day of the month. Reserve before a model or provider call. Hitting a hard limit stops new
  work, including work remaining under existing reservations, and cancellation cascades through
  descendants; there is no graceful-finishing exemption. Already-dispatched provider charges
  cannot be undone, so reservations must use a trustworthy worst-case price. Unknown cost is not
  treated as zero. Separately, the live OpenAI MVP qualification envelope is €5 total across all
  test attempts, retries and models, using cheap models; it is not €5 per run and does not change
  the product's monthly budget semantics. Reserve a conservative bound across the whole envelope
  before paid dispatch; unknown cost is never treated as free.
- **Late subchat participants:** a person joining a shared subchat may see all existing history of
  that joined subchat, but receives no implicit access to the parent conversation or private
  resources. Current conversation access and explicit resource grants still govern every read.
- **Per-tool approval settings:** replace the proposed read-only certification flow with simple
  human controls per installed connection and tool: **Allow automatically**, **Ask**, or **Block**.
  The user confirmed this scope on 28 September. The interaction should
  use OpenCrane's own style and icons, with the supplied image serving only as a visual reference.
  Execution permissions, owner identity and revocation remain separate; automatic mode is an
  explicit human policy choice and never means every tool is allowed. Selecting **Allow
  automatically** also approves future permitted writes, including the first write, without an
  additional first-write prompt; current authority, connection/tool permissions and revocation
  remain mandatory, and the default **Ask** behavior is unchanged.
- **Fresh qualification:** the user authorizes ongoing fresh `testv6` qualification and requires
  verified superseded TEST deployments to be retired after each test so compute does not accumulate.
  Exact resources, in-use state and shared dependencies must be checked first. This is not blanket
  permission to delete production data, backups or unrelated infrastructure, and does not authorize
  recreating a laptop VM.
- **Credential handling and delegation:** an OpenAI key may be used only through secure
  configuration from `./keys`; it must never be read into output, committed or exposed. Delegate
  implementation and test work to cheaper Luna/Sol models; root orchestrates and reviews.

These decisions supersede older pending group-attribution/history, “no deploy permission”,
unresolved numeric live-test-cap and first-write/Always-policy text only where those statements
conflict. Historical evidence is retained in the original OpenCrane repository.
