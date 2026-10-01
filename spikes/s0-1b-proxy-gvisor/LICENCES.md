# Runtime licences and pins

Checked 1 October 2026 before using these artefacts. No new npm runtime library
was added: the scripts use Node's standard library and the already selected
Codex release. This is Linux x86-64 only.

| Component | Pin | Licence / evidence |
| --- | --- | --- |
| Node / Debian Bookworm slim | `22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3` | MIT Node; bundled notices in `/usr/local/LICENSE`. Debian runtime packages carry their notices in `/usr/share/doc/*/copyright`; GNU tools GPL, glibc LGPL-2.1-or-later, standard BSD/MIT/Apache libraries. |
| Codex | `@openai/codex@0.159.2`, Linux x64 alias `@openai/codex@0.159.2-linux-x64` | Apache-2.0, npm metadata and [upstream licence](https://github.com/openai/codex/blob/rust-v0.159.2/LICENSE); versions and npm integrity hashes in the lockfile. |
| Codex bundled native voice libraries | The native package above | Checked its `codex-resources/voice/NOTICE.md`: LGPL-2.1 GStreamer/GLib; MIT/BSD-style libffi, PCRE2, Opus; zlib. Notices and source archive hashes accompany the image. Windows-only Microsoft runtime is not installed in this Linux image. |
| agentgateway | `v1.5.0@sha256:bf2f339ef326d32def2aaeb44b1b4549801293c19b89e764a4228667d97d9896` | Apache-2.0, upstream GitHub licence API and image label `org.opencontainers.image.licenses`; source revision `fe6732474a96a0363dfb9822859af4e9bab360fa`. Existing S0.2 selection, Chainguard glibc base. |
| Tool launcher | Source `tool-user.c`, host GCC static build | Own code using Linux syscall headers and glibc (LGPL-2.1-or-later); source is retained so it can be rebuilt/relinked. No libseccomp dependency or compiler is added to the image. |
| Existing k3s, gVisor, Agent Sandbox, registry | Developer box pins | Apache-2.0; see [developer-box inventory](../../infra/devbox/README.md#pinned-versions). |

Only the two applicable Codex npm packages are installed. npm, Corepack and Yarn
are removed from the finished image, including their build-tool data packages.
The final image keeps upstream runtime notices. No BSL/KLv1/commercial database
or other non-OSI runtime component is introduced. The Debian package inventory
is generated into `.state/image-packages.tsv` during the documented inspection:

```sh
docker run --rm 127.0.0.1:5001/opencrane/s01b:spike \
  dpkg-query -W '-f=${Package}\t${Version}\n'
```

The retained proof gives the custom image digest. Existing Codex dependency
research is also in [S0.1c's inventory](../s0-1c-real-model-smoke/LICENCES.md).
Native environment configuration was checked against the
[pinned Codex source](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/exec-server/src/environment_toml.rs),
not assumed from a newer release's documentation.
