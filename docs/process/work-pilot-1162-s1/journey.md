# Pilot VM sizing and bootstrap receipt

Date: 20 November 2026. Branch: `work/pilot-1162-s1`.

Journey on a fresh dev stack: NOT RUN

## Expected journey

Claim a fresh secondary package slot after the exclusive resource window; use
package-prepare, package-up and package-check with CI-approved images. Sign in,
chat, upload, view the desktop and check budgets at 1280 and 390 pixels, first
with one person and one assistant computer, then three people concurrently.
Sample per-pod and total CPU, memory and occupied disk at idle and peak. Copy
logs and masked screenshots before package-down and down release the slot.

## Observed blocker

The real `fetchApplicationApproval()` consumer from
`infra/package/application-approval.mjs` returned **Application CI approval refused**,
with cause `stage: metadata, reason: malformed`. It requires successful packaging
output for the exact source commit and branch. The tested checkout was
`1bbf2b733` (the failing-test commit, with the implementation still uncommitted).
The [original safe refusal log](logs/image-approval.log) retains the result.
After all source gates passed, the same real consumer refused again for committed
implementation `412bb98758bd8c37a2c6686c0a0c38aeb3803b35`, with the same metadata cause.
The [final attempt](logs/final-image-approval.log) records that committed source.
No alternate image, fake approval, guard change or fleet-marker change was used.

The [resource observations](logs/resource-window.jsonl) began with both secondary
ids free, no package namespace and load below 6. The five-minute qualifying period
reset when slot 1 became occupied. A subsequent status command waited on the
slot's standard operation lock, so no continuous five-minute free window was
established. Waiting was stopped after the independent image-approval refusal;
this is not a claim that the two-hour resource wait expired.

No secondary slot was claimed. No package was prepared or installed, no secondary
startup ran, and no service logs or screenshots were produced. There is no owned
stack to tear down. The owner stack and host runtime/network settings were untouched.
No paid resource or model call was made.

## Measurements

| Workload | Idle CPU / RAM / disk | Peak CPU / RAM / disk | Browser journey |
| --- | --- | --- | --- |
| One person, one assistant | NOT RUN | NOT RUN | NOT RUN at both widths |
| Three concurrent people, three assistants | NOT RUN | NOT RUN | NOT RUN at both widths |

A minimum VM size and headroom cannot be derived from these absent measurements.
The ticket's sizing outcome is incomplete. The draft cannot merge until its
fresh packaged journey and measurements pass with approved images.

## Safe bootstrap checks

The [own-check receipt](checks.md) records ShellCheck, container refusal and
configuration tests and their limits. Container fixtures use no host network,
no added capabilities and no privileged mode; their source mount is read-only.
No fixture starts a Kubernetes or container runtime. The first real bootstrap,
reboot and package installation on an Ubuntu pilot VM remain NOT RUN.
No independent review result is claimed.
