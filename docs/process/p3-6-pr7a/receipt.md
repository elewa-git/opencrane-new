# Hosted image vulnerability check: local evidence

The private Grype adapter checks the Syft package list from a verified OCI image.
It refuses High and Critical findings, stale database facts and scanner errors.
It now uses copies of the checked image, SBOM and database values for evidence,
and refuses a change to the caller's values during the scan. The combined licence
and vulnerability check refuses extra reviewed packages that Syft did not find.
Grype 0.121.0 reports the image as the source of a Syft image SBOM; the adapter
checks that source against the verified manifest, platform and layers.

The pinned Grype binary and local database fixture are test tools. No real
database archive or runtime image was reviewed or packaged in this change.

## Checks

| Check | Result | Evidence |
| --- | --- | --- |
| Failing-first tests | PASS | Commit `9b6063009`; three focused tests failed before the fix. The digest mutation returned a false pass. |
| Changed tests, first run | PASS | 40 tests in the hosted vulnerability and licence files, with `PG_TEST_URL` set and one worker. |
| Changed tests, second run | PASS | The same 40 tests passed again. |
| Changed-file ESLint | PASS | Both changed TypeScript source files and both changed TypeScript test files. |
| Typecheck | PASS | Workspace `npm run typecheck`. |
| Event catalogue | PASS | 162 event types agree. |
| Knip | PASS | Two existing configuration hints; no unused exports. |
| Changelog check | PASS | Release-note fragment accepted. |
| Markdown and diff checks | PASS | Markdownlint and `git diff --check`. |
| Root suite and live scanner | NOT RUN | The root suite was excluded; no live scanner or dev stack was started. |

No production caller or event writer uses this adapter yet. Hosted admission
still needs the other independent checks. Replay reads saved metadata only.
