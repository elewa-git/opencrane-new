Operators can take and list one nightly backup of the pilot event log, all databases
and uploaded files. The package stops writers, drains read tables, checks one shared
position and publishes a manifest only after every part succeeds. Backups use a
separate local volume. Failed runs appear as failed Kubernetes Jobs and never as
complete backups. Restore remains a separate slice.
