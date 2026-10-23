Gateway preparation and delivery now share a lock in the content database across processes. The dispatcher uses the server's read-only connection for that lock, keeps jobs in their own database, and refuses missing or unavailable content settings before handlers start.

Gateway delivery keeps the existing file when its lock connection is lost. Expired preparation stops without saving a later generation and releases its lock; waiting for that lock has a separate time limit.
