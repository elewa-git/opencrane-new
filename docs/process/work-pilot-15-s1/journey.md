# Packaged file uploads

Journey on a fresh dev stack: FAIL — the Compose fresh-stack journey passed, but the
packaged journey stopped before package preparation when `target-up --id 2` exited
non-zero with: “DEV_STACK_DIR must be an empty dedicated directory outside the
repository, or owned by this worktree”. The stack cleanup completed.

Recorded on 13 November 2026 for issue #15, slice 1 of 3. Rebased head:
`4c07a6120b590f21c85a07fc88821cd30937bc0b`.
The browser journey is a merge condition. Component checks do not satisfy it.

The automatic Compose journey on the fresh secondary stack passed the upload,
answer and EICAR refusal checks at 1280 px and 390 px. It wrote screenshots named
`upload-1280.png`, `upload-390.png`, `preview-1280.png`, `preview-390.png`,
`workspace-1280.png` and `workspace-390.png` in the claimed slot's private
directory. Slot cleanup removed that directory, so those files are unavailable to
attach to this receipt. They would be Compose screenshots, not evidence for the
packaged installation.

The packaged journey did not start. After the Compose journey passed, I stopped it
as required before preparing the separate package namespace. `target-up --id 2`
then failed with the guarded error above. The launcher hid its underlying cause;
the likely failure is target or slot directory ownership validation, but the exact
cause is unknown. No package namespace or installation was created, and no
packaged browser steps or screenshots were captured. `package-down --id 2` and
`down.sh --id 2` completed; the slot reported free.

## Earlier attempt (12 November 2026)

1. Checked `origin/main` and open pull requests before starting. This slice was
   neither merged nor open. Read the issue's owner decisions and Slices comment.
2. Ran `npm ci` and linked the existing NATS and link-checking tools.
3. Built the application, object-store and scanner images. Verified a fresh scanner
   release against its three actual databases and independently approved manifest.
4. Ran the source gates below, then claimed secondary slot **1** through `claim.sh`.
5. Ran the standard `journey-entry.ts` guard with that claimed id. It refused:
   **Automated journeys require a secondary stack and no fleet task**.
   `requireAutomatedJourney` rejects the inherited `OPENCRANE_FLEET_TASK` setting.
   The setting was preserved and the guard was not bypassed.
6. Ran `run.sh package-down --id 1` and `down.sh --id 1`. Both exited zero.

No packaged namespace or installation was created. `package-prepare`, private
preparation, `package-up`, `package-check` and browser sign-in were **NOT RUN**
after the guard refusal. Neither the owner stack nor its ports were used.

A separate image publication attempt through the existing loopback registry failed
with **connection reset by peer** while Docker attempted HTTPS to
`127.0.0.1:5001`. This environmental registry failure is outside this PR; the PR
changes no registry publication implementation. The reviewed images exist locally; their presence
in the registry and their installation on Kubernetes have not been proved.

## Packaged browser acceptance

| Width | Packaged clean upload and answer | Packaged EICAR refusal | Screenshot |
| --- | --- | --- | --- |
| 1280 px | NOT RUN | NOT RUN | Not captured |
| 390 px | NOT RUN | NOT RUN | Not captured |

Compose clean upload, answer and EICAR refusal passed at both widths as recorded
above. Packaged clean upload, answer, refusal and screenshots were NOT RUN because
target setup failed before package preparation.

The next attempt needs a fresh secondary slot and packaged installation in the
order documented in
[the dev-stack contract](../../../infra/dev-stack/README.robot.md).
Use a newly reviewed scanner release if the recorded database check has expired.
At each width, sign in, start a chat, choose a small text or PDF file through Attach,
wait for Ready, and ask for a fact present only in that file. Save the chat answer.
Then choose the EICAR test file and save the visible
**File refused: malware detected.** message. Always run package-down and down.

## Own checks

| Check | Result |
| --- | --- |
| Scanner, HTTPS service, release and real storage fixtures: 154 tests | PASS twice |
| Chart, upload services, rendering and preflight: 318 tests | PASS twice |
| Installer and private-setting refusals: 269 tests | PASS twice |
| Database backup chart compatibility: 207 tests | PASS twice |
| Licence and promotion checks: 82 tests | PASS twice |
| Actual application image layers, imports and native hashes: 11 tests | PASS twice |
| Root workspace and infrastructure typecheck | PASS |
| `check:events`: 174 catalogue entries | PASS |
| Knip | PASS |
| Changelog lint | PASS |
| ESLint on changed files | PASS |
| Additional ESLint on infrastructure JavaScript ignored by the root config | PASS |
| Markdown lint | PASS |
| Public privacy and secret scans | PASS |
| Actual all-layer image scan and source-bound licence promotion | PASS |
| Browser journey on a fresh packaged installation | NOT RUN |

Tests, typecheck, lint and builds ran under `nice -n 10`. Vitest used two workers.
No full root test suite ran. No application web source changed; the actual package
image build compiled the website. Infrastructure TypeScript remains ignored by the
repository's ESLint configuration and is covered here by its strict typecheck.

The production packaged adapter was also exercised inside the built application
image against the pinned ClamAV engine in an isolated Docker network namespace.
It verified the mounted database bytes before returning **clean** for small text
and **infected** for EICAR. This was a component check, without a browser or chat.
Its disposable container was removed. The real MinIO fixture verified short-lived
leases, renewal, object access and refusal of another bucket and bucket creation.

## Image records

The application image was built from committed source
`47258e903347daaaf2727da636d4bca3f0f53a36`. Later commits change chart delivery,
reviewed image records, test fixtures and this receipt. They change no application
runtime module copied into that image.

- Application image: `sha256:1d4e3cf8ef189954fe1a2e6751de79e3c37c9f9742b14186163447bef8f3c22c`.
- Scanner image: `sha256:126d7e9292b6c260c60d4fc945bb74698ddd387da474b73bca78d3b0ad2becfb`.
- Object-store image: `sha256:adf12617265bc7ff63369b81854605493964424a90d9e713c14ae62a8cd3e31c`.

The inventory covers 580 application-image components, 243 object-store components
and 112 scanner operating-system packages. The scanner's GPL engine and bundled
notices are recorded separately. Signed Debian main indexes cover every installed
OS package. The image inventory also records the reviewed CC0 hashing library
bundled inside AGPL MinIO, as allowed by the runtime-layer policy.

## Work log and cleanup

Started with failing tests for package services and source-bound image promotion.
A real image check then exposed hidden shell files in the upstream scanner database
folder. Removed that folder before copying the exact reviewed database set.
Pinned loaded scanner facts before cleaning up shared code. Reproduced and fixed
Kubernetes delivery of Secret files and numeric non-root engine identity.

Shared the bounded ClamAV transport, release validation and fixed production engine
settings. Deleted the duplicate development transport. Split model runtime settings
from private package preparation. Historical licence fixtures now use a fixed
baseline and explicit unreviewed inputs, so later promotion cannot rewrite their
claims. No event, business-state or access-check contract changed.

The change has **972 changed shipped-code and configuration lines** (additions plus
removals), excluding tests, documentation and generated licence/release records.
This includes the two dependency declaration lines and the new authentication-library
export. The root declaration reuses the already installed Apache-2.0 MinIO client
for the real storage test.
The worktree is retained for review. The claimed slot and disposable test containers
were released; the existing shared registry and test database were left in place.

## Review repairs

Recorded on 13 November 2026. Own source checks: PASS. CI is recorded on the PR.
Capability: NOT RUN, awaiting #1119 and the complete fresh packaged journey.
Fetched `origin` and completed `git rebase origin/main`: already up to date.

- Finding 2: reproduced the historical inventory failure and missing scanner values.
  The historical tests now accept the current review, then explicitly remove its
  source revision to prove refusal. The NATS fixture supplies the reviewed scanner.
  Production approval checks were not relaxed.
- Finding 3: reproduced a credential and response-body canary through the real STS
  provider and structured logger. Issuance discards upstream errors and retains only
  a fixed message and structured cause classification. The canary now passes.
- Finding 4: bounded issuance to ten seconds and connected cancellation to the actual
  socket and response body. A separate readiness entrypoint shares the server's lease
  validator. Controlled time covers stalled headers and bodies, expiry, cancellation
  and recovery. The probe allows five seconds for Node startup and file validation;
  it does not load the STS client or full authentication library.
- Finding 5: added isolated refusal inputs and proved rotation after the service
  rejects the previous lease. Deliberately removed each of the twelve guards below,
  saw the corresponding test fail, then restored it. No broken guard was committed.
- Finding 6: shared regular-file, database size and streamed hash validation in
  `infra/clamav/database.mjs`, with both refresh and packaged caller coverage.
  Extracted named fixtures and cases in all four files listed by the review.
- Finding 7: reproduced the nine-box diagram count and removed the indirect NATS
  neighbour. The scanner diagram now has eight boxes.

| Deliberately broken guard | Isolating test with guard removed | Restored |
| --- | --- | --- |
| Database symlink | FAIL: startup accepted the link | Yes |
| Database minimum size | FAIL: startup accepted 511 bytes | Yes |
| Database maximum size | FAIL: startup accepted 512 MiB plus one byte | Yes |
| Input is a Buffer | FAIL: scan accepted a Uint8Array | Yes |
| Input maximum size | FAIL: scan accepted 20 MiB plus one byte | Yes |
| Byte-count equality | FAIL: scan accepted a different count | Yes |
| Clock rollback | FAIL: scan accepted the earlier clock | Yes |
| Abort after scan | FAIL: scan returned clean after cancellation | Yes |
| Lease expiry | FAIL: HTTP was attempted with an expired lease | Yes |
| Lease maximum age | FAIL: HTTP was attempted with an overlong lease | Yes |
| Per-request credential read | FAIL: rotated request reused the retired credential | Yes |
| Approved scanner hash equality | FAIL: preflight accepted another well-formed hash | Yes |

The symlink fixture keeps the target bytes, link size and actual byte count valid.
The size fixtures match the modified bytes' hashes. The input fixtures keep every
other binding valid. These failures therefore test the named guard independently.

Test commits preceded the production fix. Cleaned the changed code against the
engineering standard: shared decisions, small named functions, separate statements,
no new dependencies, no copied schema and no changed business-state or event contract.
Two NATS fixture cases hit their existing process deadline while checks ran in
parallel; the remaining verification runs serially without changing those deadlines.

The application image was rebuilt from the production fix commit named above.
The source-bound promotion check passed for all eight image roles; the application
and website each contain the same 580 reviewed components. Re-authenticated all
three Debian main indexes and checked their package lists before changing the
image pin. The actual archive and container passed all 11 image-layer checks.
No registry publication or packaged journey was attempted during these repairs.

| Review verification | Result |
| --- | --- |
| Scanner, refresh, credential, storage and Docker fixtures: 60 tests | PASS twice |
| Historical image fixtures: five suites, 48 Python checks | PASS twice |
| Chart and preflight: 70 checks | PASS twice |
| NATS route preparation: 19 checks | PASS twice, serially |
| Existing server storage-refusal checks: seven tests | PASS |
| Controlled manual guard-removal checks: twelve | PASS: each isolated test failed, then guard restored |
| Workspace and infrastructure typecheck | PASS |
| `check:events`: 174 catalogue entries | PASS |
| Knip, changelog lint and changed-file ESLint | PASS |
| Additional ESLint for changed infrastructure JavaScript | PASS |
| Markdown lint | PASS |
| Public privacy and secret scans | PASS |
| Rebuilt image, all-layer scan, source-bound promotion and Debian main verification | PASS |
| Actual rebuilt image layer and container checks: 11 tests | PASS |
| Fresh packaged journey and both browser widths | NOT RUN: waiting for #1119 |

Retained the worktree for review. No dev stack was claimed during these repairs;
Docker fixtures removed their own disposable containers and images. The rebuilt
application image remains available locally for the later fresh qualification.
