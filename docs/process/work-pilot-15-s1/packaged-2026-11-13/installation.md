# Packaged installation failure

Recorded on 13 November 2026. Tested code: `ba6d15abf23c0e003a38d9b18ef3d9c8495fbe10`.
Secondary slot: **1**. `package-prepare` and private preparation passed.
`package-up` reached bootstrap and failed to obtain its reviewed images.
The browser journey and screenshots were NOT RUN.

## Fresh installation identity

- Namespace: `opencrane-package-1`
- Namespace UID: `1988d88e-d092-4063-9ad2-e035fc04d0c4`
- Helm install id: `3c2be162-9a15-4cfb-ad4c-3df79808d4c3`

All four new claims were Bound before cleanup:

```text
conversation-keys   56eb74ac-88ae-4d71-9eaa-fd8f8ee19d01   Bound
data-nats-0         db788957-7276-46c7-a150-60961fd73c36   Bound
data-objects-0      ec8b2cfa-043c-416d-810e-b8575d95f718   Bound
data-postgres-0     3ac17331-2c97-41a5-b567-6e319c86a5e8   Bound
```

## Registry errors

Kubernetes reported these errors during this installation:

```text
Failed to pull image "k3d-ocn-registry:5000/opencrane/package@sha256:1d4e3cf8ef189954fe1a2e6751de79e3c37c9f9742b14186163447bef8f3c22c": rpc error: code = NotFound desc = failed to pull and unpack image "k3d-ocn-registry:5000/opencrane/package@sha256:1d4e3cf8ef189954fe1a2e6751de79e3c37c9f9742b14186163447bef8f3c22c": failed to resolve reference "k3d-ocn-registry:5000/opencrane/package@sha256:1d4e3cf8ef189954fe1a2e6751de79e3c37c9f9742b14186163447bef8f3c22c": k3d-ocn-registry:5000/opencrane/package@sha256:1d4e3cf8ef189954fe1a2e6751de79e3c37c9f9742b14186163447bef8f3c22c: not found
Failed to pull image "k3d-ocn-registry:5000/opencrane/objects@sha256:adf12617265bc7ff63369b81854605493964424a90d9e713c14ae62a8cd3e31c": rpc error: code = NotFound desc = failed to pull and unpack image "k3d-ocn-registry:5000/opencrane/objects@sha256:adf12617265bc7ff63369b81854605493964424a90d9e713c14ae62a8cd3e31c": failed to resolve reference "k3d-ocn-registry:5000/opencrane/objects@sha256:adf12617265bc7ff63369b81854605493964424a90d9e713c14ae62a8cd3e31c": k3d-ocn-registry:5000/opencrane/objects@sha256:adf12617265bc7ff63369b81854605493964424a90d9e713c14ae62a8cd3e31c: not found
```

The bootstrap Pod was Pending with `ImagePullBackOff` in its init container.
The installer was stopped with SIGTERM after those errors were recorded; its
existing bootstrap timeout was unchanged. No browser retries were attempted.

## Pod state before cleanup

```text
bootstrap-nxh6q                         Pending   PodInitializing
nats-0                                  Running   <none>
objects-0                               Pending   ImagePullBackOff
openfga-7fcf798595-x6t4z                Pending   PodInitializing
postgres-0                              Running   <none>
scanner-7b5dff5cdd-s6bgl                Pending   PodInitializing,PodInitializing
server-85f9d57647-6ks2f                 Pending   PodInitializing,PodInitializing,PodInitializing
web-ddb77f9f4-lf498                     Pending   ImagePullBackOff
worker-audit-59548fff86-gdr28           Pending   PodInitializing
worker-budgets-6d5b857db-pxnz2          Pending   PodInitializing
worker-computers-7d58c977c4-7wbrk       Pending   PodInitializing
worker-conversations-c5c5748bb-z8fs6    Pending   PodInitializing
worker-dispatcher-75fc779d68-4b4hp      Pending   PodInitializing
worker-files-78f88fc6db-9b7xm           Pending   PodInitializing
worker-mcp-catalogue-7f76475d58-klnpq   Pending   PodInitializing
worker-members-686b5c4586-l9zfq         Pending   PodInitializing
```

Cleanup: **PASS**. `package-down --id 1` and `down.sh --id 1` both exited
zero. The slot then reported `free`; the package namespace was absent.
