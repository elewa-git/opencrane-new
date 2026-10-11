# Dated tool catalogue snapshots

Tool catalogues retain exact definitions and original check expiry during replay.
Unchanged checks preserve waiting approvals. Published servers with expired, failed
or missing check evidence are unavailable. Older records remain readable.

Saved tool definitions must match their hashes before any review or approval can be reused.
Catalogue checks renew only the exact server and silo they checked. Incomplete older lists
need a complete discovery before they can be used again.

Tool decisions share one saved history for rules and review details. This avoids
repeated catalogue reads using up the short memory discovery deadline when remember
is blocked. All access and catalogue checks still apply.
