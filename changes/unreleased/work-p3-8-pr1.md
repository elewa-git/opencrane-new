Private connection credentials can now be staged and recovered as one immutable
Kubernetes Secret generation. Recovery checks the saved bindings, contents, UID
and version. A lost create reply without independent identity evidence is refused,
and the create is never sent again. Deletion requires both exact identity checks and
confirmed absence. Secrets kept by a finaliser remain unresolved until a later check
confirms removal. Private repair records survive a process restart. Credentialed routes and material release remain closed.
