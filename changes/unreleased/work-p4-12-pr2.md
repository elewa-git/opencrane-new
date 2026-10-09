People can list and search their own memory and permitted group or assistant notes
through the HTTP API. Unicode search keeps whole words and normalises accents.
The live ops memory worker keeps the read tables current using existing revision keys;
without a configured key directory, memory reads return `503 memory_unavailable`.
Pages stay within their size limit, replace oversized facts with unavailable placeholders,
and use signed cursors that keep the first page expiry time. Owners and admins gain no
access to another person's facts through their role. Detail and storage follow separately.
