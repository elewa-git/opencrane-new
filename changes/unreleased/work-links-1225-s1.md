Chat messages now link bare HTTPS and www. addresses, email addresses and shared-file
paths in both member messages and assistant replies. Shared files open in the file
viewer, and links to this app change pages without a reload. Unsafe schemes and code
stay unlinked. Links support keyboard use and wrap on phones.

Internal file-publication checks stay out of chat history, so publishing a shared
file keeps the conversation readable. History reads also skip these internal rows
when an older worker has already saved them, without needing a rebuild.

The packaged model stand-in includes the helper used by chat-link checks.
