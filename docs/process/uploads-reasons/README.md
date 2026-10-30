# Upload refusal checks

Date: 30 October 2026. Source: `04f000894e370caa35430aa6b80eb1932caaf409`.
The test-first commit is `b63c45cb1`. All files and people shown are synthetic.
The local checks use disposable PostgreSQL, NATS, OpenFGA and upload services.
Browser checks use the production build and an intercepted API, not a fresh installation.

Expected: each refused file has a fixed reason, useful advice and Retry upload.
Accepted Office files, HTTP status codes, size messages and rate-limit messages stay the same.
Observed: all ten reason codes, response statuses and safe log checks pass twice.
All twenty browser cases pass twice, including retry and no page overflow.

| Check, run under `nice -n 10` | Result |
| --- | --- |
| Worker, Office, HTTP and size suites: 110 cases, twice; security rules: 460 cases | PASS |
| Angular upload tests: nine cases, twice | PASS |
| Existing upload integration suite: seven cases, twice | PASS |
| Strict response and log checks: 23 cases, twice | PASS |
| Production web build | PASS |
| `node scripts/capture-uploads-reasons.mjs`, twice | PASS |
| `npm run check:events`; `npm run lint:changelog` | PASS |
| All lint stages, including Knip; `npm run typecheck` | PASS |
| Whole root suite and fresh-install journey | NOT RUN |

Lint uses `NODE_OPTIONS=--max-old-space-size=8192`, as CI does. Code and dependency
checks passed in the full lint run. The remaining stages passed after registering
the capture script as an entry point.

Earlier Office, size and integration repeats exceeded their time limits under shared
CPU load. Isolated reruns pass with the same production limits. The Office part-limit
case also passes on its own. Server typecheck and lint pass after tightening the log check.

| Reason | 1280 pixels | 390 pixels |
| --- | --- | --- |
| Unsupported type | [Image](unsupported_type-1280.png) | [Image](unsupported_type-390.png) |
| Content mismatch | [Image](content_mismatch-1280.png) | [Image](content_mismatch-390.png) |
| Macros | [Image](macros-1280.png) | [Image](macros-390.png) |
| Embedded object | [Image](embedded_object-1280.png) | [Image](embedded_object-390.png) |
| External link | [Image](external_link-1280.png) | [Image](external_link-390.png) |
| Encrypted file | [Image](encrypted-1280.png) | [Image](encrypted-390.png) |
| Inspection size limit | [Image](too_large-1280.png) | [Image](too_large-390.png) |
| Document part limit | [Image](too_many_parts-1280.png) | [Image](too_many_parts-390.png) |
| Invalid file | [Image](invalid_file-1280.png) | [Image](invalid_file-390.png) |
| Unsafe name | [Image](unsafe_name-1280.png) | [Image](unsafe_name-390.png) |
