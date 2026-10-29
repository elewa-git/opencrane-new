# Native personal recall protocol

Part of #97. Base: `6ca1912e5`. Test-first commit: `04570cad4`.
This is local protocol evidence with synthetic preparation inputs marked test-only.
It is not qualification of memory access, the gateway or a customer installation.

The test uses pinned Codex 0.159.2 in the existing disposable computer image,
with external networking disabled and its temporary home on tmpfs. It reuses the
single-recall builder and loader, private configuration, caller registry and real
loopback proxy. A free local scripted model emits a function call. Codex creates
the MCP request and sends the reply back to that model on its ephemeral thread.
The recording upstream checks the personal scope, arguments, native protocol and
call/thread metadata. It replaces the real gateway and backend.

The initial tests failed before implementation: the native runner was absent and
the CI image list omitted the test. A diagnostic also found that native `never`
consent refuses the call before HTTP. The test now requests native consent and
accepts exactly one MCP request for its expected thread, turn and recall server.
This is test-only consent. Shell, file and browser settings remain disabled;
no production configuration or admission is changed.

| Case | Upstream calls | Replies containing the test value consumed by Codex |
| --- | --- | --- |
| Discovered without a grant | 0 | 0 |
| Matching caller, thread, turn and generations | 1 | 1 |
| Foreign caller | 0 | 0 |
| Foreign thread at the other caller's catalogue | 0 | 0 |
| Ended registration | 0 | 0 |
| Expired grant | 0 | 0 |
| Cancellation during a partial reply | 1 | 0 |
| Lost reply | 1 | 0 |
| Second native session after the other cases | 1 | 1 |

The foreign cases substitute transport identity or address, preserving the complete
native request. Each turn emits one native call and consumes one result or refusal.
Lost replies carry the proxy's uncertain-result notice and are not resent.
The fixture checks private native notifications as well as the next model request
for unwanted disclosure. Only counts and outcomes leave the container.

## Own checks

- PASS: `npm ci` and the requested NATS and Lychee symlinks.
- PASS: changed native test twice, one test covering all nine cases per run
  (19.70 and 18.80 seconds). The CI fixture-list tests passed twice, 10/10 each.
- PASS: unchanged event security rules, 460/460, once.
- PASS: event catalogue, 157 event types agree; separate Knip and changelog checks.
- PASS: typecheck for every workspace and both infrastructure projects.
- PASS: full lint, including code, dependencies, documentation, links, fixture
  rules, package licences and changelog. The final focused ESLint check also passed.

All tests and checks ran under `nice -n 10`; Vitest used one worker. The final
native and security tests used the supplied `PG_TEST_URL` on port 55432.
These tests do not connect to PostgreSQL or require a projection database.
The final direct fixture run saved [counts and outcomes](protocol.json).
Its image was `ocn-upload-computer:test`, local image id
`sha256:c72eafd94319227d3d48dd9baadf74bf01ec8d0de7b0c2f7baf3219c04534377`.
Repository sources were mounted read-only. No image was rebuilt or published.
Local check logs use `/tmp/p4-15-pr5b-` followed by `native1.log`, `native2.log`,
`list2.log`, `security.log`, `lint.log` and `typecheck.log`.
Earlier fixture development failures are not passing evidence.

## Limits

Admission remains off. No product files, event schemas or dependencies changed.
No caller bytes, grants or test value are saved in this receipt.
Disk isolation, loaded-reference accounting, backend/gateway qualification and all
live fresh-install journeys: NOT RUN. No external model, dev stack or owner-stack
change was used. No full root suite was run.
