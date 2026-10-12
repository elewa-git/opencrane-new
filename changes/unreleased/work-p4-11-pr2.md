Internal child-task admissions now check signed decisions, saved parents and narrower
model access, and enforce limits across server replicas. Native tasks and their
spending remain disabled.
Concurrent retries with changed scopes are refused; identical retries return the
original saved admission.
