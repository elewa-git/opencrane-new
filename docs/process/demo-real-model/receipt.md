# Managed real replies: first part

20 October 2026. Part of #32. Overall result: PARTIAL.

The opt-in uses the existing product provider APIs and the production OpenAI route.
The default startup and nightly still use the local stand-in. No dependency, event
or API field was added. The authority tests and event security rules are unchanged.

## Live checks

Only secondary id 1 was claimed and used. The first fresh attempt at
`bf0b158e0f448f03999ef69958fd769e0060c486` stopped at reachability: UNKNOWN,
with no paid call. Ordinary Node HTTPS worked on the host and in models, but the
pinned gateway returned 503 inside models because it lacked certificate roots.
The same unauthenticated gateway probe returned 401 on the host. After mounting
host certificates read-only, the container probe also returned 401. No network
settings were changed.

The next fresh startup included that fix at `3023bab88`. The browser helper was
updated before its launch; [fresh.json](fresh.json) records the checked source SHA.
Provider reachability and consented model verification passed. The exact quote
reserved 1 cent and charged 1 cent. Model selection, the explicit default, drain
and switch-on passed. Running models had neither `MODEL_KEY_FILE` nor
`MODEL_UPSTREAM`. Both certificate and custody mounts were read-only.

The arithmetic reply streamed, contained 437 and survived reload: PASS.
Stop saved its request after text arrived, but neither the conversation nor the
computer received an end report within the browser check: FAIL. The browser kept
showing Stopping. The stopped call's 16-cent hold remained unresolved. The earlier
completed chat charged 3 cents. No stopped turn or unknown provider write was sent
again. The independent member checks were then run separately. The first member turn
ended with `bridge_interrupted` and a denied decision before any reservation.
After that recorded failure, one new attempt passed, as did the supplier PDF
question and reload. The answer contained EUR 1,234.56 and 17 November 2026.
[qualification.json](qualification.json) records five paid calls: 10 cents charged
and 16 cents still held. [member-attempt-1.json](member-attempt-1.json) retains the
failed attempt; [member-followup.json](member-followup.json) records the later proof.
The member joined after switch-on. The complete fresh journey remains FAIL.

The deployed computer image was
`sha256:2a0fe2d8c956f0b03d4267c476aa514239697d18ca7473dea6674f22c0e78be6`,
from source `2b4d7358fc0729821766e866d6e23de5c193565b`. It predates the newer
stop-access code. A newer image fixing this failure is NOT PROVEN. Releasing and
qualifying a computer image is left for the next part rather than widening this
provider change beyond its roughly 600-line limit.

## Own source checks

PASS: changed tests twice (12 each), event security rules (438), event catalogue
(149 types), workspace typecheck, full lint (including knip) and changelog check.
No full root test suite was run. Secondary id 1 cleanup and release: PASS.
Credential-pattern scan: PASS for 388 events and 19 logs; exact-value live scan:
NOT RUN. Synthetic error/redaction canaries passed.
The supplementary dev-stack-only TypeScript check reported existing errors in
mcp-journey, wake-latency, zitadel-setup tests and a daily-fresh test inference.
The required workspace typecheck is recorded separately below.

## Fixture isolation incident

The first failing preparation test called the old function before it accepted the
new file-path argument. It read the default authentication settings and created
one new stub credential file in the default directory. The attempted request had
no server address and reached no API. The file's creation time matched this test;
it was removed. No existing file was overwritten, and no owner container, port
or running service was changed. Subsequent preparation checks used secondary id 1
and then moved to an isolated disposable directory, including for regressions.
