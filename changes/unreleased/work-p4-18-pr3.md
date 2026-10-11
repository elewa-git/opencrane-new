# Encrypted welcome survey progress

Private survey records can rebuild four-step progress, saved dates and encrypted
answers. A saved answer must have a matching SHA-256 hash of its encrypted bytes.
Parsing and replay check that hash without private keys. Editing a step removes later current answers; restarting begins a new
generation while keeping encrypted history.

A configured membership reaction prepares one private key, including for members
without an assistant. It checks current membership and creates no assistant or work.
Survey commands, HTTP routes, persona approval and welcome screens come later.
