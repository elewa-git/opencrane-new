# Kubectl build information and Go terms

Date: 29 October 2026. Part of #15. Overall: PARTIAL. Live: NOT RUN.
Base: `f973912f8`. Failing-first test commit: `62da082d6`.

The [record](build.json) binds kubectl v1.37.1 to the original candidate binary
SHA-256 `65691ff77eb6fa44c908b77a1082c9f092c3b9733b5cefabec0d1104890e21a8`.
The checker first runs the unchanged candidate checks, including scan, source,
configuration and Debian signature checks. It then compares the archived Dockerfile
and every kubectl copy across all layers. Exactly one regular file is present.
Kubectl is never run. GNU objcopy reads its `.go.buildinfo` section into a temporary
file, with a separate output copy so the input stays unchanged.

The authentic 4,336-byte [section](buildinfo.bin.gz) reports Go `go1.26.8`, main
module `k8s.io/kubernetes v1.37.1`, 88 dependency modules and no replacements.
Nine dependencies report `(devel)`; no version is inferred for them. The saved scan
calls these `UNKNOWN` and adds `stdlib go1.26.8`, giving 90 Go rows altogether.
The record keeps exact names, versions, empty sums and all build settings, including
the reported VCS revision. These labels prove no source ancestry or unmodified build.
The small [ELF fixture](buildinfo.elf.gz) keeps the authentic section using objcopy's
`--only-section`; other executable contents are removed. Large binaries stay outside Git.

## Official source and retained terms

The official [download list](https://go.dev/dl/#go1.26.8) gives the source archive
SHA-256 `4e39b98e42f946fa05ac8bc5b71877df97dbdb7cbb1a777b541667ad7117fd2e`.
The downloaded archive matches. Its VERSION, LICENSE, PATENTS and runtime
`memmove_amd64.s` match files read
from [official commit c293dd4](https://github.com/golang/go/tree/c293dd49cbe25e1fe8d97d94a5cb618e7b6d831e),
reported by both official repository mirrors for tag `go1.26.8`.
The parser follows the inline format in that source's `src/debug/buildinfo/buildinfo.go`
and module rows in `src/runtime/debug/mod.go`; unsupported formats refuse.

The complete [BSD-3-Clause notice](LICENSE.gz) retains The Go Authors' copyright,
source and binary redistribution conditions, the Google LLC endorsement restriction
and the full disclaimer. The complete [patent grant](PATENTS.gz) retains its scope
and litigation termination condition. The [amd64 memory-copy source](memmove_amd64.s.gz)
retains complete MIT terms naming Lucent Technologies, Vita Nuova and The Go Authors.
The reported Linux/amd64 settings select this runtime source file.
Its permission covers use, changes and redistribution with the notices retained;
MIT is already OSI-approved. These notices must accompany distribution.
This reviews runtime notices for the reported compiler; it does not establish
all linked runtime contents or cover third-party module grants. There is no proof
that the reported compiler built this binary, or that the recorded source reproduces
it. Complete kubectl attribution is still missing.
Top-level Kubernetes Apache terms supply no blanket approval. Module grants,
agentgateway, complete kubectl approval and image promotion remain BLOCKED.

## Own checks

Environment: existing Linux host, fresh `npm ci`, linked NATS and Lychee tools.
Seven fixtures failed before implementation and were committed first. Offline tests
use authentic section/notice bytes and small archive envelopes. Positive fixtures
exercise objcopy and the real parser. Tests reject exact module/version/replacement
changes, incomplete information, missing licence lines and partial-scope changes.
Archive, decoder and child failures must give fixed stderr and empty stdout.
The missing runtime attribution also failed first before its source fixture was added.

| Own check | Result | Observation |
| --- | --- | --- |
| Changed fixtures, twice | PASS | Seven offline Python tests through the existing Vitest glob. |
| Comparison removal probes | PASS | Removing each of seven comparisons makes the fixtures fail. |
| Licence and preflight fixtures, twice | PASS | 77 licence and 41 preflight cases per run. |
| Event security rules | PASS | All 460 cases pass; the protected source is unchanged. |
| Saved candidate and Go source | PASS | Original binary, all layers, recipe and official source notices agree. |
| Promotion command | FAIL | Expected exit 1, empty stdout and fixed stderr; exact-source R3 remains missing. |
| Lint, typecheck, events, Knip and changelog | PASS | Commands ran under nice priority; tests used the requested PG_TEST_URL where needed. |

Tools: Node 22.23.3, Python 3.12.3 and GNU objcopy 2.42. Logs: `/tmp/p5-4-images12/`.

No approved inventory, image pin, runtime Dockerfile, promotion gate, event/API or
access code changes. Rebuild, registry operations, stack/model calls, full root suite
and fresh/live qualification: NOT RUN.
