Conversation lists now return bounded pages ordered by activity the person can see, with Recent, Archived and visible-title search. Empty pages can carry a continuation, and changed lists reset paging. Existing installations need an offline conversation replay before restarting chat readers and workers; the current website still loads the first page.

Conversation paging ignores other people's private and denied activity, and continuations
refer only to visible matches. Late joiners see their join time without earlier creation
details. Oversized scans return an incomplete reply without a cursor. Offline replay
upgrades the previous participant tables before creating the new activity index.
