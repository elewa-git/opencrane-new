People can record facts in their own memory, a group they belong to, or assistant
notes with a separate write grant. Changed commands conflict; a lost reply stays
unknown and can be checked without another write. Revision keys are kept while
an append is uncertain and unused keys are reconciled after a definite failure
or a restart. Shared scopes refuse private message sources and preferences.
Browser screens and fresh-install qualification remain pending.

Write permission now comes before content checks and command locks. Busy commands
return promptly. Chat sources use an indexed message lookup after access is checked.
Resolved command records are removed and their fingerprints never include text.
Recovery runs in the background. An unknown write keeps its key until the append
window has ended and a later scope event proves that the delayed write cannot be
saved. A timeout by itself leaves the result unknown. Older records without their
expected scope position also keep their keys. Oversized events are refused before
making a key.

Slow scope reads no longer fill the database pool: locked checks read only newer
events with a short time limit, and recovery reads history before taking a connection.
