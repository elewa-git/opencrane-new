# Initial personal memory contract

Part of #97, P4-15 PR 5d. This is the authorised load-command-only split.

`prepareInitialMemory` is an internal server workflow. Its caller supplies the exact
silo, requester, assistant, computer, generation, conversation, turn and thread.
It accepts only an already restricted private turn on the requester's personal assistant.
The caller cannot supply qualification evidence. The workflow reads the deployment-owned
collector output at `/etc/opencrane/private-memory-qualification-result.json` through
`readDeploymentQualification`. It requires the collector's nine PASS checks, both complete
P4-14/P4-15 qualifications, and eleven distinct receipt digests. The reader measures the
current source, image, Docker host, silo, container start and event-store creation again.
A missing, unsafe, changed, incomplete or foreign file refuses. The same collector run
must remain current through preparation and loading. Access is checked after the final
deployment read. A final synchronous file check catches qualification withdrawal during
that access check. The deployment host must provide
the protected configuration and Docker access described in the collector contract.
Tests run the real collector against simulated filesystem and Docker boundaries.

Selection reuses `turnMemoryPreview`: stable preferences then pins, whole records,
32 references and 16,384 UTF-8 bytes including JSON and identity. A selected group or
notes reference refuses the whole command. Preview alone appends nothing and grants nothing.
The scope position and projection generation must remain unchanged through both commands.
Empty selection still requires personal recall permission.

Each command first reads saved membership, then makes one membership permission decision.
It retains the original ownership and membership positions and captures other small access
streams before using their permissions. The same ten-second preparation deadline covers
all reads. Each permission is checked once per command; later confirmations check saved
access positions. Unchanged membership does not need another history read. Changed
positions trigger a membership read so removal keeps its specific refusal. Removal takes precedence over catalogue or permission outages. Loading
makes a fresh decision while retaining the original prepared facts and qualification run.

Each command appends one `agent.memory_context_recorded` event conditionally.
Preparation records no additions. Loading records the complete selected references.
The existing fold validates ordering and bounds. Full history loads before each short
access check; only small access streams are watched. Turn activity is checked by reading
new events. The original two-second write deadline also applies after each append.

The returned `load` function is consumed before waiting. A failed or uncertain append
cannot repeat it. Saved preparation prevents a fresh preparation from restarting the turn.
Cold replay retains references and `executionAvailable: false`. Neither command returns
fact text, credentials, a release callback or a dispatch permission. Saved membership
refusals retain `MemberAccessRefused`; other failures use `memory_context_unavailable`. No event or public API fields or dependencies are added.

Native launch, credential/input hooks and release remain unbuilt. Full P4-14 and P4-15
receipts remain mandatory for enablement; the admission assertion and disabled state
are unchanged. Caller-supplied PASS objects cannot qualify this command.
The shared authority helper accepts a command-owned permission reader which retains the
captured access positions. Existing callers keep their existing checks. Authority tests
and admission assertions are unchanged.

Own checks and fresh-install limits are in [the receipt](receipt.md).
