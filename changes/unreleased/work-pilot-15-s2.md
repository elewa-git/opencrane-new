Operators can take and list one nightly backup of the pilot event log, all databases
and uploaded files. The package stops writers, drains read tables, checks one shared
position and publishes a manifest only after every part succeeds and all stopped
services are ready again. Failed readiness keeps maintenance active and publishes
nothing, including during recovery from a failed part. Backups use a
separate local volume. Failed runs appear as failed Kubernetes Jobs and never as
complete backups. Restore remains a separate slice.

The application image checks include the backup runner and all its imported modules.

Application images now require exact-source CI approval after saved-layer checks,
all-layer scanning, licence checks and authenticated Debian main indexes. Local
builder pins cannot approve an image for package preparation or installation.

Approval regression checks cover each application role separately, configuration
digests, all three authenticated Debian indexes and bundled or manual licence
refusals. Fork, local and mismatched-checkout producers stop before Docker or
publication. The workflow policy is fixed in code rather than a review setting.
