Private connection credentials can now be staged and recovered as one immutable
Kubernetes Secret generation. Recovery checks the saved bindings, contents, UID
and version. Deletion requires both exact identity checks. Private repair records
survive a process restart. Credentialed routes and material release remain closed.
