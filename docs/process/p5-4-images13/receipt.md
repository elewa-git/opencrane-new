# Bundled ms source and terms

Date: 29 October 2026. Part of #15. Overall: PARTIAL. Live: NOT RUN.
Failing-first test commit: `4ad273798`. Base: `123ef7fba`.

The [record](grant.json) accepts only the MIT grant for ms 2.1.3 in Corepack 0.34.6.
The complete [licence](license.md.gz) names Vercel, Inc., 2020. MIT is OSI-approved.
It permits use, changes and redistribution with the copyright and permission notice
retained. The full warranty disclaimer is retained too. The bundled ms module has
no licence notice. Complete terms must accompany image distribution before promotion.
No existing bundled allowance or reason changes.

The source came through upstream Git from
[commit 1c6264b](https://github.com/vercel/ms/tree/1c6264b795492e8fdecbc82cb8802fcfbfc08d26),
identified by tag `2.1.3`. No package registry supplied these files.
Compressed fixtures retain complete `index.js`, `license.md` and `package.json`.
The record pins their lengths, SHA-256 values and compressed SHA-256 values.

The checker removes documentation comments and blank lines, changes single quotes
to double quotes, writes `1000` as `1e3` and `undefined` as `void 0`, joins the
error string's continuation line, and adds the CommonJS wrapper and indentation.
It renames `module`, `parse`, `plural` and `name` to the bundle's local bindings
and removes the space after the anonymous `function` keyword.
The result equals all 3,024 bytes at `[84609, 87633)`, SHA-256
`4923ee89533c070866a34628ea4d0ca3e2724c06ae4796103403160d9d38928e`.
This proves the reviewed comparison; it does not reproduce the original build command.
Package labels, hashes alone and Corepack's MIT claim grant no dependency approval.

The earlier inventory and source fixture bind the exact module and range identities.
Unchanged inherited checks authenticate Node's signed release/tag, Git source,
release source, official installation and every candidate layer. They keep the
455-component comparison, 88 Debian main packages and archived Dockerfile checks.
Saved inputs were hashed against existing records before archive inspection.
Historical observations, other grant decisions, embedded Wasm, unknown source,
vulnerabilities and complete image approval remain BLOCKED. Unproved source refuses.
The separate is-windows decision remains unchanged. Promotion still needs exact-source R3.

## Own checks

Environment: fresh `npm ci`, linked NATS and Lychee; no runtime dependency added.
Logs and Git checkout: `/tmp/p5-4-images13/`. All suites and gates use `nice -n 10`.
The ten fixtures failed before the checker existed and were committed first.
Authentic positive bytes test the comparison. Refusals cover missing, duplicate or
substituted module/range identities, source/version changes, omitted grant terms,
altered attribution/transformation, missing/extra candidate copies and bad inputs.
Errors return exit 1, empty stdout and fixed stderr without local paths or tracebacks.

| Check | Result | Observation |
| --- | --- | --- |
| Changed fixtures, twice | PASS | Ten Python cases through Vitest on each run. |
| Licence and preflight fixtures | PASS | 77 licence and 41 preflight tests. |
| Signed source, official archive and saved candidate | PASS | Full inherited check and exact ms comparison. |
| Event security rules | PASS | 460 tests, requested PG_TEST_URL and one worker; source unchanged. |
| Comparison removal probes | PASS | Disabling each of eight direct comparisons makes fixtures fail. |
| Lint, typecheck, events, Knip and changelog | PASS | Full commands; lint has zero errors and 34 warnings in unchanged files. |
| Actual promotion | FAIL | Expected exit 1 and fixed refusal; fixture identifies missing exact-source R3. |
| Complete licensing and vulnerability clearance | BLOCKED | Other reviews remain outstanding. |
| Full root suite, rebuild, registry, stack and model calls | NOT RUN | Excluded by this task. |
| Fresh installation and live qualification | NOT RUN | No live approval claimed. |
