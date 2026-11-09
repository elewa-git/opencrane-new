# Local image check fixture

Date: 9 November 2026. Base: `6dcfed82b`. The failing test was committed as
`0cab77587` before the verifier change. The inert reviewed test image has digest
`f788a8e48a6e743d02004e2ab817c870d8cfe4a0a7ff0058c456ea53121e7ddc`.
It is generated from the existing licence fixture. No image was published.

| Check category | Tool version and pinned SHA-256 | Status |
| --- | --- | --- |
| Failing-first tests | Forged verifier and mismatched saved attempt | PASS: both failed before the source fixes |
| Publisher signature | Cosign 2.6.1 · `064954c5d8c7e3b28188eee5b1727b31c411550bc5fefd41aa672d3c761d103a` | PASS: valid signature and real bad signature |
| Image licences | Syft 1.54.0 · `d46a9a61a6ae3d367f0a03748c5e9c59253e586c4388ab26ddcacebc2efa0d92` | PASS: reviewed test image |
| Vulnerabilities | Grype 0.121.0 · `bd511334178bc3002eb9eb58880f89e01e35f7fed7cfbe671171127a8afa3596` | NOT RUN: no fresh pinned database archive |
| Licence data | SPDX data 3.28.0 · `f728c534d8bd1044fc515a2ddb2292be99559021d830bfa3281be0bcd36302ee` | PASS: pinned local data |
| Malware | Local authenticated scanner with a clean test verdict | PARTIAL: the verdict is a fixture |
| Saved refusal | Real bad Cosign signature through the checked queue | PASS: one dated rejection and no second scan after restart |
| Clean admission | Real Cosign and Syft, unavailable Grype database | PASS: attempt remains checking |
| Input binding | Wrong silo, attempt, digest, platform, repository, actor or missing layer | PASS: no image decision |
| Broken verifier | Replacement program prints a success string | PASS: attempt remains checking |
| Scanner date | Database timestamp older than 24 hours | PASS: attempt remains checking |
| Missing or malformed receipt | Existing queue fixtures | PASS: no image decision |
| Cancellation | Cancelled worker before claim and after separate checks | PASS: no saved failure |
| Output limit | Oversized child output in Grype's scanner path | PASS: unavailable, output discarded |

The local fixture does not qualify Grype's scan output or a real ClamAV image scan.
The separate signature, licence and vulnerability gates remain required. Hosted
execution and promotion remain closed. The fresh-install two-silo journeys and
deployment checks remain **NOT RUN**.
