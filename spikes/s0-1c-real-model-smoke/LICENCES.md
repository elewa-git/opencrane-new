# Dependency and binary licences

No new npm dependency was added. The existing lockfile pins every package below,
including optional packages for other platforms. Evidence: each package's
`license` field in `package-lock.json`; the installed package metadata agrees.
Only macOS arm64 and Linux amd64 are supported. Windows packages are excluded
from execution: Codex's bundled `voice/NOTICE.md` explicitly identifies the
Microsoft Visual C++ runtime as separately licensed proprietary software.

| Binary / bundled library | Version | Licence and evidence |
| --- | --- | --- |
| Node.js | 22.15.0 tested; Node 22 required | MIT, [release licence](https://github.com/nodejs/node/blob/v22.15.0/LICENSE) includes its third-party notices |
| npm | 11.3.0 | Artistic-2.0, installed npm package metadata |
| agentgateway | 1.5.0, revision fe6732474a96a0363dfb9822859af4e9bab360fa | Apache-2.0, [release licence](https://github.com/agentgateway/agentgateway/blob/v1.5.0/LICENSE); binary checksums in scripts/fetch-tools.sh copied from S0.2 |
| Codex native binary | 0.159.2 | Apache-2.0, npm metadata and bundled codex-package.json |
| Bash | 3.2.57 tested | GPL-2.0-or-later, `bash --version`; operator scripts |
| Codex bundled zsh | 5.9.0.3-test | MIT, zsh distribution licence; shell execution disabled |
| libffi | 3.8.0 | MIT, bundled voice/licenses/libffi.txt |
| PCRE2 / sljit | 10.47 / bundled with PCRE2 | BSD-3-Clause, bundled voice/licenses/PCRE2.md and sljit.txt |
| zlib | 1.3.2 | Zlib, bundled voice/licenses/zlib.txt |
| Opus | 1.6.1 | BSD-3-Clause, bundled voice/licenses/Opus.txt |
| GLib | 2.88.3 | LGPL-2.1-or-later, bundled voice/NOTICE.md and licences |
| GVDB | 2b42fc75f09dbe1cd1057580b5782b08f2dcb400 | LGPL-2.1-or-later, included in GLib; bundled voice/sources.json |
| proxy-libintl | 0.5 | LGPL-2.0-or-later, bundled voice/licenses/proxy-libintl.txt |
| GStreamer, gst-plugins-base, gst-plugins-good | 1.28.6 each | LGPL-2.1-or-later, bundled voice/NOTICE.md and sources.json |

Voice libraries are bundled by Codex but voice is disabled. Meson 1.12.0
(Apache-2.0) and Ninja 1.13.2 (Apache-2.0), listed in that sources.json, are
upstream build inputs, not installed tools. No Windows CRT is installed here.
Host utilities (`cat`, `env`, `mkdir`, `mktemp`, `mkfifo`, `rm`, `sleep`, `uname`,
`ps`, `chmod`, `shasum`) are supplied by the host OS; the tested host is macOS
15.7.4, not a customer runtime image. BSD utilities use BSD licences; shasum
is Perl's Artistic-1.0/GPL dual licence. curl 8.7.1 uses the curl licence and is only
needed for fetching the pinned binary. Linux host utility versions must be
recorded when that platform is qualified; Linux is NOT_RUN here.

Excluded, not downloaded: KurrentDB (KLv1), SurrealDB and Redpanda (BSL),
EventSourcingDB (closed source), Axon Server (commercial), as required by the
repository AGENTS.md. No replacement storage component is needed by this harness.

## Complete npm lockfile inventory

| Package (including optional platform packages) | Version | Licence |
| --- | --- | --- |
| @esbuild/aix-ppc64 | 0.28.2 | MIT |
| @esbuild/android-arm | 0.28.2 | MIT |
| @esbuild/android-arm64 | 0.28.2 | MIT |
| @esbuild/android-x64 | 0.28.2 | MIT |
| @esbuild/darwin-arm64 | 0.28.2 | MIT |
| @esbuild/darwin-x64 | 0.28.2 | MIT |
| @esbuild/freebsd-arm64 | 0.28.2 | MIT |
| @esbuild/freebsd-x64 | 0.28.2 | MIT |
| @esbuild/linux-arm | 0.28.2 | MIT |
| @esbuild/linux-arm64 | 0.28.2 | MIT |
| @esbuild/linux-ia32 | 0.28.2 | MIT |
| @esbuild/linux-loong64 | 0.28.2 | MIT |
| @esbuild/linux-mips64el | 0.28.2 | MIT |
| @esbuild/linux-ppc64 | 0.28.2 | MIT |
| @esbuild/linux-riscv64 | 0.28.2 | MIT |
| @esbuild/linux-s390x | 0.28.2 | MIT |
| @esbuild/linux-x64 | 0.28.2 | MIT |
| @esbuild/netbsd-arm64 | 0.28.2 | MIT |
| @esbuild/netbsd-x64 | 0.28.2 | MIT |
| @esbuild/openbsd-arm64 | 0.28.2 | MIT |
| @esbuild/openbsd-x64 | 0.28.2 | MIT |
| @esbuild/openharmony-arm64 | 0.28.2 | MIT |
| @esbuild/sunos-x64 | 0.28.2 | MIT |
| @esbuild/win32-arm64 | 0.28.2 | MIT |
| @esbuild/win32-ia32 | 0.28.2 | MIT |
| @esbuild/win32-x64 | 0.28.2 | MIT |
| @jridgewell/sourcemap-codec | 1.6.0 | MIT |
| @napi-rs/lzma-linux-x64-gnu | 1.5.1 | MIT |
| @openai/codex | 0.159.2 | Apache-2.0 |
| @openai/codex-darwin-arm64 | 0.159.2-darwin-arm64 | Apache-2.0 |
| @openai/codex-darwin-x64 | 0.159.2-darwin-x64 | Apache-2.0 |
| @openai/codex-linux-arm64 | 0.159.2-linux-arm64 | Apache-2.0 |
| @openai/codex-linux-x64 | 0.159.2-linux-x64 | Apache-2.0 |
| @openai/codex-win32-arm64 | 0.159.2-win32-arm64 | Apache-2.0 |
| @openai/codex-win32-x64 | 0.159.2-win32-x64 | Apache-2.0 |
| @rollup/rollup-android-arm-eabi | 4.63.6 | MIT |
| @rollup/rollup-android-arm64 | 4.63.6 | MIT |
| @rollup/rollup-darwin-arm64 | 4.63.6 | MIT |
| @rollup/rollup-darwin-x64 | 4.63.6 | MIT |
| @rollup/rollup-freebsd-arm64 | 4.63.6 | MIT |
| @rollup/rollup-freebsd-x64 | 4.63.6 | MIT |
| @rollup/rollup-linux-arm-gnueabihf | 4.63.6 | MIT |
| @rollup/rollup-linux-arm-musleabihf | 4.63.6 | MIT |
| @rollup/rollup-linux-arm64-gnu | 4.63.6 | MIT |
| @rollup/rollup-linux-arm64-musl | 4.63.6 | MIT |
| @rollup/rollup-linux-loong64-gnu | 4.63.6 | MIT |
| @rollup/rollup-linux-loong64-musl | 4.63.6 | MIT |
| @rollup/rollup-linux-ppc64-gnu | 4.63.6 | MIT |
| @rollup/rollup-linux-ppc64-musl | 4.63.6 | MIT |
| @rollup/rollup-linux-riscv64-gnu | 4.63.6 | MIT |
| @rollup/rollup-linux-riscv64-musl | 4.63.6 | MIT |
| @rollup/rollup-linux-s390x-gnu | 4.63.6 | MIT |
| @rollup/rollup-linux-x64-gnu | 4.63.6 | MIT |
| @rollup/rollup-linux-x64-musl | 4.63.6 | MIT |
| @rollup/rollup-openbsd-x64 | 4.63.6 | MIT |
| @rollup/rollup-openharmony-arm64 | 4.63.6 | MIT |
| @rollup/rollup-win32-arm64-msvc | 4.63.6 | MIT |
| @rollup/rollup-win32-ia32-msvc | 4.63.6 | MIT |
| @rollup/rollup-win32-x64-gnu | 4.63.6 | MIT |
| @rollup/rollup-win32-x64-msvc | 4.63.6 | MIT |
| @types/chai | 5.2.3 | MIT |
| @types/deep-eql | 4.0.2 | MIT |
| @types/estree | 1.0.9 | MIT |
| @types/node | 22.20.4 | MIT |
| @vitest/expect | 3.2.7 | MIT |
| @vitest/mocker | 3.2.7 | MIT |
| @vitest/pretty-format | 3.2.7 | MIT |
| @vitest/runner | 3.2.7 | MIT |
| @vitest/snapshot | 3.2.7 | MIT |
| @vitest/spy | 3.2.7 | MIT |
| @vitest/utils | 3.2.7 | MIT |
| assertion-error | 2.0.1 | MIT |
| cac | 6.7.14 | MIT |
| chai | 5.3.3 | MIT |
| check-error | 2.1.3 | MIT |
| debug | 4.4.3 | MIT |
| deep-eql | 5.0.2 | MIT |
| es-module-lexer | 1.7.0 | MIT |
| esbuild | 0.28.2 | MIT |
| estree-walker | 3.0.3 | MIT |
| expect-type | 1.4.0 | Apache-2.0 |
| fdir | 6.5.0 | MIT |
| fsevents | 2.3.3 | MIT |
| jose | 6.2.12 | MIT |
| js-tokens | 9.0.1 | MIT |
| loupe | 3.2.1 | MIT |
| magic-string | 0.30.21 | MIT |
| ms | 2.1.3 | MIT |
| nanoid | 3.3.19 | MIT |
| pathe | 2.0.3 | MIT |
| pathval | 2.0.1 | MIT |
| picocolors | 1.1.1 | ISC |
| picomatch | 4.0.7 | MIT |
| postcss | 8.5.28 | MIT |
| rollup | 4.63.6 | MIT |
| siginfo | 2.0.0 | ISC |
| source-map-js | 1.2.2 | BSD-3-Clause |
| stackback | 0.0.2 | MIT |
| std-env | 3.10.0 | MIT |
| strip-literal | 3.1.0 | MIT |
| tinybench | 2.9.0 | MIT |
| tinyexec | 0.3.2 | MIT |
| tinyglobby | 0.2.17 | MIT |
| tinypool | 1.1.1 | MIT |
| tinyrainbow | 2.0.0 | MIT |
| tinyspy | 4.0.6 | MIT |
| tsx | 4.23.15 | MIT |
| typescript | 5.9.3 | Apache-2.0 |
| undici-types | 6.21.0 | MIT |
| vite | 7.3.6 | MIT |
| vite-node | 3.2.4 | MIT |
| vitest | 3.2.7 | MIT |
| why-is-node-running | 2.3.0 | MIT |
