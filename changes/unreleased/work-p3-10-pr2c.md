- Accept private tool-instance observations only from a short-lived worker pass bound
  to the saved owner, profile, server, run and Pod. Refuse stale or changed reports;
  missing workloads stay unknown. Starting, credential release and admin commands
  remain unavailable.
- Stop observation retries when a worker pass expires or is replaced. Retain only
  credential digests in the server and remove expired worker registrations automatically.
