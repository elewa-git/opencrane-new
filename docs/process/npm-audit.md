# npm audit findings

The audit on 7 October 2026 found 18 vulnerable package entries in the full
workspace dependency tree. Four entries appeared in the production dependency
tree. Those entries came from MinIO in the server. The computer image has a
separate lockfile for `playwright-core` and `ws`; its audit found no issues.
The web build tools are development dependencies and do not go into the web
bundle.

The table records each entry from the first audit. A path starts at the package
that OpenCrane uses directly. “Dev only” means the package runs during install,
lint or build, but does not ship in the server, web bundle or computer image.

| Package | Path into OpenCrane | Where it ships | Reachable in our use | Action |
| --- | --- | --- | --- | --- |
| `@angular/build` | `@opencrane/web` → `@angular/build` → `piscina` | Dev only | The builder uses its worker pool while building the web app. It is not part of the web bundle. | Updated to 21.2.25, a patch release. |
| `@angular/cli` | `@opencrane/web` → `@angular/cli` → `@modelcontextprotocol/sdk` | Dev only | The CLI is run for web builds and tests. Its MCP OAuth client is not used by those commands. | Kept 21.2.24. Overrode the SDK to fixed 1.31.0. |
| `@modelcontextprotocol/sdk` | `@opencrane/web` → `@angular/cli` → SDK | Dev only | No MCP server or OAuth client is started by our build or test commands. | Overrode to 1.31.0. |
| `braces` | `markdownlint-cli2` → `globby` → `fast-glob` → `micromatch` → `braces` | Dev only | It handles file patterns in the documentation linter. It does not process customer input. | Accepted for now. npm offers only a breaking markdownlint-cli2 change as a fix. |
| `decode-uri-component` | server → `minio` → `query-string` → decoder | Server | MinIO uses it when it handles request query strings. Malformed encoded values can reach that code. | Overrode to fixed 0.5.0. |
| `fast-glob` | `markdownlint-cli2` → `globby` → `fast-glob` | Dev only | It finds documentation files for linting. Its patterns come from our checked-in lint command. | Accepted with the `braces` and `micromatch` findings; npm offers a breaking linter downgrade. |
| `globby` | `markdownlint-cli2` → `globby` | Dev only | It finds documentation files for linting. | Accepted with the `braces` and `micromatch` findings; npm offers a breaking linter downgrade. |
| `http-cache-semantics` | `@angular/cli` → npm install tools → `make-fetch-happen` → cache rules | Dev only | It is used by npm while fetching packages. It is not used in a running silo. | Updated by `npm audit fix` to a patched compatible release. |
| `katex` | `markdownlint-cli2` → `markdownlint` → `micromark-extension-math` → `katex` | Dev only | The Markdown linter checks math syntax in repository files. It does not render customer content. | Accepted with the Markdown linter findings; npm offers a breaking linter downgrade. |
| `markdownlint` | `markdownlint-cli2` → `markdownlint` | Dev only | It checks repository Markdown during lint. | Accepted with the Markdown linter findings; npm offers a breaking linter downgrade. |
| `markdownlint-cli2` | Root development dependency | Dev only | It runs only in the lint job. | Kept at 0.23.3. npm's suggested 0.21.0 change is breaking. |
| `micromark-extension-math` | `markdownlint-cli2` → `markdownlint` → math extension | Dev only | It checks math in repository Markdown. | Accepted with the Markdown linter findings; npm offers a breaking linter downgrade. |
| `micromatch` | `markdownlint-cli2` → `globby` → `fast-glob` → `micromatch` | Dev only | It matches checked-in documentation paths during lint. | Accepted with the `braces` finding; npm offers a breaking linter downgrade. |
| `minio` | server → MinIO client | Server | The server uses MinIO to store and fetch files. | Kept at 8.0.7. Fixed its query decoder; accepted the unused notification parser path below. |
| `piscina` | `@opencrane/web` → `@angular/build` → `piscina` | Dev only | It runs build workers while compiling the web app. It is not in the web bundle. | Overrode to fixed 5.3.2. |
| `query-string` | server → `minio` → `query-string` | Server | MinIO uses it to read and build request query strings. | Kept at 7.1.3. Its vulnerable decoder is fixed by the override above. |
| `smol-toml` | `markdownlint-cli2` → `smol-toml` | Dev only | It reads linter configuration during lint. The configuration is checked in. | Accepted for now. npm offers only a breaking markdownlint-cli2 change as a fix. |
| `stream-json` | server → `minio` → `stream-json` | Server | MinIO imports its JSON-lines parser for bucket notifications, but OpenCrane does not call the notification listener. | Accepted. A fixed major version breaks MinIO's file import. The vulnerable parser path is unused by OpenCrane. |

The remaining findings outside the server are in development tools. The
production audit has two moderate entries for MinIO and its unused notification
parser. CI audits the workspace and the computer image, and fails for high or
critical shipped findings while allowing the documented moderate parser finding.

## Checks

| Check | Result |
| --- | --- |
| `npm ci` | PASS |
| `npm audit --omit=dev --json` | Two moderate entries for MinIO and its parser remain and are accepted above; no high or critical findings |
| Computer runtime lock audit | PASS, zero findings |
| `npm audit --json` | Development-tool findings and the two accepted moderate shipped entries remain; npm exits non-zero |

## 29 October 2026 update

The root production audit initially reported six affected package entries: one
low, two moderate and three high. The separate computer runtime audit reported
zero findings, so its package files do not change.

| Package | Shipped path | Change | Licence |
| --- | --- | --- | --- |
| `decode-uri-component` | server → MinIO → query-string → decoder | 0.5.0 → 0.5.1 | MIT |
| `fastify` | server, demo tool server and Odoo tool server; also auth test provider | 5.12.5 → 5.12.6 | MIT |
| `fast-uri` | server → Ajv; Fastify → Ajv compiler / JSON serialiser → Ajv | 3.1.8 → 3.1.9 | BSD-3-Clause |
| `fast-uri` | Fastify → Ajv compiler / JSON serialiser | 4.2.1 → 4.2.3 | BSD-3-Clause |

The same lockfile update fixes the development copies of fast-uri under Angular,
the MCP SDK and OpenFGA's syntax transformer. Registry licence metadata and each
changed package's installed licence file were checked; all are OSI-approved.
No package was added.

Keep the decoder override because MinIO's latest release, 8.0.7, still requires
query-string 7.1.3, which requires decode-uri-component `^0.2.2`. No compatible
patched parent release is available. The override selects the patched decoder
without replacing MinIO or query-string. Fast-uri updates stay within their
parents' existing ranges and need no override.

The decoder update fixes
[GHSA-qr28-fpjm-wq7f](https://github.com/advisories/GHSA-qr28-fpjm-wq7f).
The Fastify update fixes
[GHSA-389g-gv7q-r4x8](https://github.com/advisories/GHSA-389g-gv7q-r4x8).
The fast-uri updates fix
[GHSA-w74x-v6f9-j3xg](https://github.com/advisories/GHSA-w74x-v6f9-j3xg),
[GHSA-xhq7-xmqj-769h](https://github.com/advisories/GHSA-xhq7-xmqj-769h),
[GHSA-wjr9-j795-jxcr](https://github.com/advisories/GHSA-wjr9-j795-jxcr) and
[GHSA-333x-w4r6-6crp](https://github.com/advisories/GHSA-333x-w4r6-6crp).

The remaining root findings are two moderate package entries: MinIO and its
stream-json 1.9.1 dependency. The parser advisories are
[GHSA-528h-pc64-c93x](https://github.com/advisories/GHSA-528h-pc64-c93x),
[GHSA-hqr4-qq8f-hg3x](https://github.com/advisories/GHSA-hqr4-qq8f-hg3x) and
[GHSA-mjw6-4jj6-33hc](https://github.com/advisories/GHSA-mjw6-4jj6-33hc).
Version 3.6.0 fixes all three, but replaces the `jsonl/Parser.js` import that
MinIO loads with `jsonl/parser.js`. Forcing that version
would break server startup. The server does not call MinIO's bucket notification
listener. This keeps the existing documented moderate finding visible; no audit
ignore or threshold change is added. A compatible upstream MinIO release is
still needed to remove it safely.
