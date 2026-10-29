# One bundled dependency's terms

Date: 29 October 2026. Part of #15. Overall: PARTIAL. Live: NOT RUN.
Original base: `9bd56b0f9`. Rebased onto `68428e46e`.
Failing-first test commit: `045686e2d` (originally `8ade0f0f0`).

The [record](grant.json) reviews only is-windows `1.0.2`, bundled by Corepack
`0.34.6`. Its MIT grant names Jon Schlinkert and permits use, modification and
redistribution with the copyright and permission notices retained. The complete
[licence fixture](LICENSE.gz) keeps all conditions and the warranty disclaimer.
The candidate's short inline claim does not contain these complete terms.
They must accompany image distribution before promotion; this change publishes nothing.

## Source and checked changes

The source was read directly from
[upstream commit 4dcfff4](https://github.com/jonschlinkert/is-windows/tree/4dcfff4ed9e36ad761a1a24d3899c832382d7254),
which the upstream `1.0.2` tag identifies. No package registry was used.
The compressed fixtures retain the complete `index.js`, `LICENSE` and `package.json`.
The record pins each file's length, SHA-256 and compressed SHA-256.

The checker applies only the reviewed text changes to the authentic source:
it moves the opening notice into the inline attribution block, changes single
quotes to double quotes, adds indentation and the CommonJS wrapper, and renames
`exports`, `module` and the local function to the bundle's bindings. The result
must equal all 1,018 bytes of range `[737365, 738383)`, SHA-256
`d19fa106ff9a6406c518cda9ade9d7d881e5ac71059834417a6354784c224a2e`.
The moved notice must match the retained attribution exactly once and in full.
This proves the reviewed source-to-byte comparison, not the original build command.
A changed or unsupported transformation refuses. Labels and Corepack's MIT licence
supply no dependency grant.

The unchanged [earlier inventory](../p5-4-images9/inventory.json) still records its
original BLOCKED observations. This separate review binds its module and range to
that inventory and its complete source fixture. The inherited checker first checks
signed Node source/tag and official files, then every candidate copy in every layer.
The candidate source, configuration, 455 components, 88 Debian main packages,
archived build recipe and prior licence records remain unchanged.

The other 20 dependencies, embedded Wasm, unknown ranges and historical Node references
remain BLOCKED. This one-module result cannot approve image promotion. Complete
licensing, vulnerability clearance, exact-source R3 and fresh installation still
need their own evidence. No runtime dependencies, pins or promotion gates change.

## Own checks

Environment: existing Linux host, fresh `npm ci`, linked NATS and Lychee binaries.
All checks use `nice -n 10`. The event security suite uses the requested
`PG_TEST_URL`; it needs no projection database. Logs: `/tmp/p5-4-images11/`.
Eight fixtures failed before the checker existed and were committed first.
Offline fixtures use authentic source bytes and synthetic archive envelopes.
They test each source file, grant condition, author, version, range, module,
transformation and attribution separately. Decoder and dependency failures must
return exit 1, fixed stderr and empty stdout, without a path or traceback.

| Check | Result | Observation |
| --- | --- | --- |
| Failing-first fixtures | PASS | Eight failures before the checker existed; tests committed first. |
| Changed fixtures, twice | PASS | Eight offline tests through the existing Vitest glob each time. |
| Comparison removal probes | PASS | Disabling each of eight comparisons makes the fixtures fail. |
| Licence and preflight fixtures, twice | PASS | 77 Python and 41 preflight tests each time. |
| Event security rules | PASS | 460 tests; source file unchanged. |
| Signed source, Corepack and candidate | PASS | Final saved evidence passes all inherited checks. |
| Promotion command | FAIL | Expected exit 1, fixed stderr and empty stdout; missing R3 stays blocked. |
| Lint and typecheck | PASS | Full commands before rebase; lint uses a 6 GB Node heap. |
| Events, Knip and changelog | PASS | Separate requested commands passed. |

The rebase kept both README additions from the newer main commit. The feature code
and evidence were unchanged. After rebase, the focused fixtures ran twice; package
typecheck, changed-script lint, documentation, links, Knip and changelog checks passed.

An earlier saved-evidence run refused after the record was reformatted while it
was running. The final run above checked unchanged bytes and passed.

Full root suite, rebuild, registry operations, development stacks, model calls and
fresh/live qualification: NOT RUN. Event/API/access code and authority tests are unchanged.
