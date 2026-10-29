# Initial personal memory contract

Part of #97, P4-15 PR 5d. This is the authorised load-command-only split.

`prepareInitialMemory` is an internal server workflow. Its caller supplies the exact
silo, requester, assistant, computer, generation, conversation, turn and thread.
It accepts only an already restricted private turn on the requester's personal assistant.
The existing qualification check requires a matching source, image and environment,
with every recall qualification condition passing. Tests supply synthetic evidence;
this module does not collect or authenticate deployment receipts.

Selection reuses `turnMemoryPreview`: stable preferences then pins, whole records,
32 references and 16,384 UTF-8 bytes including JSON and identity. A selected group or
notes reference refuses the whole command. Preview alone appends nothing and grants nothing.
The scope position and projection generation must remain unchanged through both commands.
Empty selection still requires personal recall permission.

Each command appends one `agent.memory_context_recorded` event conditionally.
Preparation records no additions. Loading records the complete selected references.
The existing fold validates ordering and bounds. Full history loads before each short
access check; only small access streams are watched. Turn activity is checked by reading
new events. The original two-second write deadline also applies after each append.

The returned `load` function is consumed before waiting. A failed or uncertain append
cannot repeat it. Saved preparation prevents a fresh preparation from restarting the turn.
Cold replay retains references and `executionAvailable: false`. Neither command returns
fact text, credentials, a release callback or a dispatch permission. Errors use only
`memory_context_unavailable`. No event or public API fields or dependencies are added.

Native launch, credential/input hooks and release remain unbuilt. Full P4-14 and P4-15
receipts remain mandatory for enablement; the admission assertion and disabled state
are unchanged. The narrower synthetic recall evidence cannot enable delivery.
No PR 5c collector is imported. The protected shared helpers and authority tests are unchanged.

Own checks and fresh-install limits are in [the receipt](receipt.md).
