# Assistant Markdown checks

Date: 30 October 2026. Source: `419ff0253`.
The failing-first commit is `8f9ca9535`: six component checks failed and one passed
against a text-only component before the renderer was written.

These checks use Node 22, Angular component fixtures and a production browser build.
The browser intercepts all API requests and live connections. All reply text is invented.
Clipboard success and refusal are simulated. No development stack is used for captures.
The root suite uses a separate, disposable PostgreSQL 17.6 container.
The test container and its volume were removed afterwards.
All lint, typecheck, build and test commands run under `nice -n 10`.
Lint uses `NODE_OPTIONS=--max-old-space-size=8192`, as CI does.

| Check | Expected result | Observed result |
| --- | --- | --- |
| Changed component suites, twice | Every element, unsafe input, long replies, live updates and copying work | PASS: 88 tests on each run |
| Event security rules | Existing event restrictions stay intact | PASS: 460 tests |
| Event catalogue | Registry and catalogue agree | PASS: 157 event types |
| Production web build | Angular templates compile | PASS |
| Intercepted browser captures | Both widths fit; unsafe text stays text; copy results appear | PASS |
| Lint, including Knip and changelog | Repository rules pass | PASS: all stages |
| Typecheck | Every workspace compiles | PASS |
| Root test suite | Existing service and integration tests pass | PARTIAL: stopped after one failure |
| Fresh-install journey | Real assistant replies render after sign-in | NOT RUN |

Code and dependency lint stages passed first. After the capture script was added to
Knip’s entry list, Knip and every remaining lint stage passed.

The broad root run reported one failure in the unchanged server memory-dispatch suite:
“refuses turn renewal when correct arrives during signing”. That case passed when run
alone afterwards. The broad run was stopped after the failure; the remaining root tests
are NOT RUN. This is not a full root-suite pass.

The remaining live check is an assistant reply journey on a fresh install.
Mermaid diagrams remain code; diagram rendering is outside this change.

The screenshots were inspected for layout and private information:

| State | 1280 px | 390 px |
| --- | --- | --- |
| Reply | [Desktop](reply-1280.png) | [Phone](reply-390.png) |
| Copied | [Desktop](copied-1280.png) | [Phone](copied-390.png) |
| Copy refused | [Desktop](copy-refused-1280.png) | [Phone](copy-refused-390.png) |

`npm run visual:chat-markdown` rebuilds and captures these examples.
The changed suites run with `npm run test -w apps/web -- --watch=false
--include=src/app/chat/assistant-markdown.spec.ts --include=src/app/chat/workspace.spec.ts`.
