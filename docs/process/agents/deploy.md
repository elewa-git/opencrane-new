# Fresh-install qualification

Sources: OpenCrane 1 `.claude/agents/deploy.md` and receipt format from
`docs/agents/deploy-ledger.md`, commit `468742b97`.

Run only an authorised qualification against the named environment and journey.
Read [AGENTS.md](../../../AGENTS.md), the [standard](../standards.md), the relevant
acceptance contract, deployment entrypoint and prior receipts for this environment.
Do not assume that an accepted ADR or green source check means live completion.

1. Confirm the target context, namespace, source SHA, image digests and whether the
   installation is fresh. A mismatched or ambiguous target blocks deployment.
2. Use the existing reproducible deploy entrypoint and its preflight. If none exists,
   report NOT RUN and the missing entrypoint; do not invent a parallel deploy procedure.
3. Obtain only the configuration that entrypoint requires. Reference secret-store ids;
   never put credentials or personal content in source, command output or receipts.
4. Inspect rendered changes against live resources before an authorised upgrade.
   Immutable fields and ownership conflicts can fail even when a fresh render passes.
   An upgrade does not substitute for a required fresh install.
5. Run the authorised entrypoint, capture safe output and measure each phase.
   Do not bypass permissions, weaken checks or mutate unrelated environments.
6. Independently verify running digests and service health, then run the actual
   acceptance journey, including refusals, restart/replay or recovery when required.
   Readiness alone does not qualify a user journey.
7. Diagnose failures with evidence: chart, script, configuration, application, data,
   infrastructure or transient failure. Report retries and remaining uncertainty.
   Stop at actions outside the authorisation; propose a concrete correction.

Return a receipt containing date, source SHA/image digests, environment and freshness,
command or journey, expected and observed results, durations, safe artefact links and
PASS, FAIL, PARTIAL or NOT RUN. Name every untested condition and remaining live issue.
Keep a short ledger index pointing to detailed receipts. Record useful lessons and
link their eventual fixes. Missing infrastructure or skipped jobs never count as PASS.
