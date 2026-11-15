# Packaged file uploads

The repaired head's qualification is recorded in the
[exact-head receipt on PR #1120](https://github.com/elewa-git/opencrane-new/pull/1120#issuecomment-6895326573).
That receipt records the final pushed source SHA, its successful scanner approval
run, the approved scanner digest, fresh installation identities, both browser
widths, screenshot checksums and cleanup results. It is updated after qualification
without creating another source commit that would select different scanner bytes.
Until that receipt records the completed run, the repaired journey is **NOT RUN**.

## Required fresh journey

Claim a secondary slot through `infra/dev-stack/claim.sh`. Keep `DEV_STACK_DIR`
outside the repository and supply the development Zitadel key by file reference.
Use only the OpenCrane 2 Dev organisation. Wait while machine load exceeds 10.
Run `up.sh --fresh` and release that Compose installation before claiming the slot
for the packaged journey. Run `run.sh package-prepare --id <slot>`, private
`prepare.ts`, `run.sh package-up --id <slot>` and `run.sh package-check --id <slot>`.
Use the package's loopback forwarder for the browser.

At 1280 and 390 px, sign in, upload a clean PDF, wait for Ready, receive an answer
containing Willow-47 from the attachment and see EICAR refused. Confirm that only
the clean attachment is saved. Save upload, answer and refusal screenshots before
cleanup. Always run `run.sh package-down --id <slot>` and `down.sh --id <slot>`.
The current head and its successful CI output must match the installed scanner.

## Review repair evidence

The test commit precedes the production repair. The controlled HTTPS host test
uses the real GitHub CLI, a locally trusted certificate and otherwise-valid run
metadata and approval ZIP. Before the repair it printed APPROVED. With the repair
it refuses before contacting the alternative host. Metadata and both artifact
downloads explicitly select github.com. Inherited enterprise settings refuse.

Structured logger tests distinguish outage, expired and malformed failures. Their
synthetic credential canary stays out of the public exception and real JSON logs.
A named per-layer inspector preserves the forbidden-library and flattened-image
checks. Synthetic archives cover forbidden libraries hidden by later layers,
multiple populated layers, an empty image and one valid populated layer.
The package README diagram contains eight boxes and connects the real callers.

Each guard below was disabled by hand in turn. Its otherwise-valid negative test
failed, then the guard was restored. No broken guard was committed.

| Deliberately broken guard | Isolating test | Restored |
| --- | --- | --- |
| Positive safe run id | FAIL | Yes |
| Safe integer run id | FAIL | Yes |
| Checkout revision syntax | FAIL | Yes |
| Non-empty branch | FAIL | Yes |
| Approval image syntax through shared release validation | FAIL | Yes |
| Approval 1,024-byte limit | FAIL | Yes |
| Release/image digest equality | FAIL | Yes |
| Publisher blob SHA-256 equality | FAIL | Yes |
| Descriptor size equality | FAIL | Yes |
| Returned manifest digest equality | FAIL | Yes |
| Plain HTTP endpoint validation | FAIL | Yes |

Publication tests change bytes under an existing archive digest while keeping its
size and manifest valid. The size test recomputes the enclosing manifest digest.
Approval tests keep all other run and artifact bindings valid. Failed approval
cannot download publishable image bytes. Invalid blobs, sizes and endpoints
refuse before publication. A wrong returned manifest digest prevents reporting
successful publication; that comparison necessarily follows the registry reply.
Queries and fragments in a registry endpoint also refuse.

Cleaned the changed code against the engineering standard: shared release syntax,
small named functions, bounded nesting, separate statements, safe structured
failure causes and no new dependency. No access, money, memory or event contract
changed. Rebased onto `0a8bda6e8354d9d289795d8da9a20c556d8dbf1d`; the rebase completed.
Source gates and the completed journey verdict are in the linked exact-head receipt.
No independent review result is claimed.

## Historical qualification

The [previous installation](packaged-rebased-2026-11-15/installation.json),
[results](packaged-rebased-2026-11-15/result.json) and six screenshots qualify only
source `bd73de7f728894c38b18e4dc5e171a2867a3acfb`, scanner approval run
[43710911559](https://github.com/elewa-git/opencrane-new/actions/runs/43710911559)
and its recorded scanner bytes. They do not qualify the repaired head.
