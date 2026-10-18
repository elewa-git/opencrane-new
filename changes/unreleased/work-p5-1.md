Local Helm package setup now refuses missing image digests, secret names and
public network settings before deployment. Secondary slot claims retain live
package ownership after the launcher exits and refuse foreign cleanup.
Package preparation now refuses a running Compose stack in the same slot. Cleanup
can recover this worktree's Helm install when its launcher stops before saving the
release identity, and secondary teardown stops Compose during a Kubernetes outage
while keeping the package record for a retry.
Cleanup now matches a saved random install ID with the Helm release label, so a
later foreign release cannot be mistaken for this worktree's interrupted install.
