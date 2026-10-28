# Shipped Corepack inventory

Date: 28 October 2026. Part of #15. Overall: PARTIAL. Live: NOT RUN.
Base: `b95a15cce`. Failing-first test commit: `c759529e3`.

The [inventory](inventory.json) records Corepack `0.34.6` at Node `22.23.1`, commit
`bd96dfbf0361576724b65322046e2ca9f9609cb9`. Its 54 files and launcher link agree
between Git, authenticated Node source, the official Linux x64 archive and every
candidate layer. The candidate remains the unchanged
[images4 record](../p5-4-images4/candidate.json), source
`0ba702c6e3ed062e7ff812875f9de873d41da4b3`, configuration
`sha256:9a6bd564f72ff4e708289f11db14ceff4e93e00cf7d7ce2e0c172fb6085fbbc5`.

## What the bytes show

The [complete bundle](https://github.com/nodejs/node/blob/bd96dfbf0361576724b65322046e2ca9f9609cb9/deps/corepack/dist/lib/corepack.cjs)
has 967,004 bytes, SHA-256
`4c348070c8937f4693d6ccb128f7d034a2542932b9ed7968cbb9a3fe38158d4a`.
The source fixture retains all Corepack files, including full inline attribution.
`regions.json.gz` records 175 consecutive byte ranges covering the entire bundle:
generated helpers, 173 comment-labelled regions and the retained attribution block.
Offsets start at zero; each end is excluded. Each row gives start, end, label and
SHA-256. Repeated labels are real separate ranges, not duplicate inventory entries.

Module rows give name, observed version, cache label, range count, SHA-256 of those
ranges joined in bundle order, and BLOCKED status. The 21 packages include typanion,
patched clipanion, semver, ms, debug, supports-color, proxy-from-env, undici,
minipass, @isaacs/fs-minipass, tar, minizlib, chownr, v8-compile-cache, isexe, which,
is-windows, cmd-extension, graceful-fs, @zkochan/cmd-shim and yallist.
Their shipped code matters even when package.json calls them devDependencies.
Clipanion's `3.2.1` comes from that file's patch locator; the exact patch source
is unproved. The inventory retains the full patched cache label rather than
claiming the unmodified npm package matches.

Undici contains two base64-encoded llhttp Wasm payloads. Their decoded sizes and
hashes are recorded separately; their versions, source ancestry and grants remain
unproved. Inline MIT claims name formdata-polyfill/Jimmy Wärting and
is-windows/Jon Schlinkert. The former has no proved version here. These are retained
claims, not approved grants. File rows give installed path relative to
`/usr/local`, kind, byte count and SHA-256 or link target.

Every byte is accounted for, but comment labels and hashes cannot prove the
complete source ancestry of generated, copied or embedded code. All dependency
grants and unknown regions remain BLOCKED. Corepack's reviewed MIT declaration
grants no blanket approval. Grant resolution follows later. The historical Node,
PCRE, Valgrind and Wasm records are unchanged; seven references and other bundles
still need work. No runtime, dependency, approved inventory or pin changes.

## Own checks and limits

Environment: existing Linux host, fresh `npm ci`, linked NATS and Lychee binaries.
No fresh install. Safe local logs: `/tmp/p5-4-images9/`.
The [checker](check-corepack.py) reuses the pinned Node release/tag signatures,
version/notice checks, official Node binary, candidate inventory, Debian-main
verification and archived Dockerfile checks. It adds exact Corepack files, link
and byte-range comparisons. It reads archives without extracting their paths.
Missing/changed inputs, hostile archives and failed dependencies give fixed errors.
A separate failing fixture covered a missing checker import before its fixed refusal was added.

| Check | Result | Observation |
| --- | --- | --- |
| Failing-first fixture | PASS | Failed before the checker existed; tests committed first. |
| Licence fixtures, twice | PASS | 72 tests each; historical evidence and independent refusals. |
| Preflight fixtures, twice | PASS | 41 tests each, including promotion refusals. |
| Saved signed source and candidate | PASS | Exact Corepack copies, 455 components, 88 Debian main packages. |
| Event security rules | PASS | 460 tests; requested PG_TEST_URL, one worker; file unchanged. |
| Lint, typecheck, events, Knip, changelog | PASS | Zero lint errors, 33 warnings; lint uses a 6 GB Node heap. |
| Initial lint attempt | NOT RUN | Stopped during TypeScript analysis with the default Node heap setting. |
| Actual promotion | FAIL | Expected exit 1; fixture confirms missing exact-source R3 approval. |
| Registry, model calls, rebuild and fresh/live qualification | NOT RUN | Outside this inventory part. |

The archive fixtures use small synthetic envelopes around authentic Corepack bytes;
they are not signed releases. Existing signature fixtures independently refuse
release/tag signatures, tag/version/commit/signer identity and signed checksum
changes. New fixtures refuse changed source/official copies, failed Git/candidate
checks, missing/duplicate/substituted files and modules, changed versions/patch
labels/hashes, extra layer copies, wrappers/links and lost inline attribution.
No complete guard-coverage or reproducible-build claim is made. Event/API/access
code and both authority tests remain unchanged. Promotion still needs complete
licence and vulnerability checks, publication, exact-source R3 and fresh journeys.

## Fixed refusal for damaged inputs

The compressed range file now has its own checksum, checked before decompression.
The existing checksum of the decoded range list still applies. Loading and checking
failures return the fixed refusal, including decoder errors, deeply nested JSON
and input paths that contain a symlink loop. These failures cannot print a traceback
with a local path. Dependency loading uses the same refusal when JSON parsing fails.

Failing-first test commit: `8d8a5ee27`. PASS: the five new tests produced six failing
cases before the fix. The fixtures use child processes and require exit 1, the exact
fixed stderr and empty stdout. Cases include byte 10 changed to `0xff`, truncated
gzip, unsupported compression, malformed JSON, invalid text encoding, deeply nested
JSON during checking and dependency loading, and a symlink loop. A separate fixture
requires the compressed checksum to be checked before the decoder runs. Decoder
fixtures also use matching compressed checksums to exercise decoder refusal itself.

Own checks for this fix: PASS — 77 licence fixtures twice, full lint, typecheck,
the event catalogue, Knip, public documentation privacy and changelog checks.
Checks use `nice -n 10`; tests use the requested `PG_TEST_URL`. Lint uses a 6 GB
Node heap. No database or development stack was needed by these fixtures.
The runtime pins, approved inventory, compressed evidence and historical licence
records are unchanged. Promotion remains BLOCKED. Full root suite, rebuilds,
registry operations and fresh/live qualification: NOT RUN.
