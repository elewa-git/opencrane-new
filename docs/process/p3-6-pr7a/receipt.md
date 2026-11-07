# Hosted image vulnerability check: local evidence

This change adds a private Grype adapter for a signed, licence-reviewed OCI image.
It checks the exact Syft package list from the verified manifest and platform.
It refuses High and Critical findings, missing or old database facts, a changed
SBOM, incomplete package details and scanner errors. Its dated result contains
digests and counts, without private report bytes.

The tool is Grype 0.121.0 for Linux amd64. The release archive and binary hashes
are pinned in `scripts/fetch-hosted-grype.sh`. The archive's top-level licence is
Apache-2.0. The local database is a test fixture; no real database archive or
runtime image was reviewed or packaged here.

## Checks

| Check | Result | Evidence |
| --- | --- | --- |
| Failing-first test commit | PASS | `98228498c`; the new test file failed because the adapter was absent. |
| Dependency install | PASS | `npm ci` in this worktree. |
| Focused tests, first run | PASS | Vulnerability, licence and admission: 59 tests. |
| Focused tests, second run | PASS | The same 59 tests passed again. |
| Existing layer walk | PASS | 18 tests. |
| Security rules | PASS | 460 tests with `PG_TEST_URL` set. |
| Changed-file ESLint | PASS | Only changed TypeScript files were checked. |
| Typecheck | PASS | Full workspace `npm run typecheck`. |
| Event catalogue | PASS | 159 types agree. |
| Knip | PASS | No unused exports; two existing configuration hints. |
| Changelog check | PASS | Fragment accepted. |
| Markdown and diff checks | PASS | Markdownlint reported no issues; `git diff --check` passed. |
| Fresh install and live shared scanner | NOT RUN | Outside this local slice. |

The combined `mcp.image_checked` result is not written by this adapter. Hosted
start and admission still require the shared production scanner contract and the
other independent checks. Existing replay reads saved metadata only.
