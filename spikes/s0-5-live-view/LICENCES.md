# Runtime licences and pins

Checked 1 October 2026, Linux amd64. The [S0.1b inventory](../s0-1b-proxy-gvisor/LICENCES.md)
still applies to the unchanged base: Node/Debian, Codex, the tool launcher,
agentgateway, gVisor and Agent Sandbox. The final tested image digest is in each
spike's evidence receipt. Dockerfile pins the base image by digest; Kubernetes
uses only the pushed digest, never the mutable build tag.

| Added component | Pin / licence evidence |
| --- | --- |
| KasmVNC server | `1.5.0-1`, [GPL-2.0-or-later package copyright](https://github.com/kasmtech/KasmVNC/blob/v1.5.0/debian/copyright); bundled libwebp is BSD-3-Clause. GPL-2.0 is OSI-approved. |
| Debian Kasm package | `kasmvncserver_bookworm_1.5.0_amd64.deb`, SHA-256 `770fd3df51510beecc89666879d82faf411276e68c6e11df612f736b891b5f71`; build checks it before installation. |
| Chromium | Debian `154.0.8037.92-1~deb12u1`, BSD with bundled BSD/MIT/Apache/LGPL components; full notices at `/usr/share/doc/chromium/copyright`. Debian main build. |
| X11 utilities / xdotool | Debian main `x11-utils` (X11/MIT) and `xdotool` (BSD); runtime notices under `/usr/share/doc/`. Used to observe the actual X server. |
| Supporting libraries | Debian main Xorg (MIT), libc (LGPL), GNU tools (GPL), OpenSSL (Apache-2.0), Perl (Artistic/GPL), standard BSD/MIT libraries; installed notices retained. `packages.tsv` in local `.state/` records exact versions. |
| WebSocket client and gateway | Existing repository `ws` package, MIT. Host spike dependency only; no new npm package, no `ws` inside the computer image. |

The Kasm package recommends **`intel-media-va-driver-non-free`**. The build uses
`--no-install-recommends` and the image audit confirms that driver is absent.
**Kasm Workspaces** is a separate product with a proprietary EULA; none of its
manager, agent, images or enterprise components is used here.

The [pinned bundled noVNC source licence](https://github.com/kasmtech/noVNC/blob/475ecfa5356579ef222983c7ce4619a7576a3bce/LICENSE.txt)
lists MPL-2.0 code, BSD HTML/CSS, OFL fonts and **CC-BY-SA artwork**. MPL/BSD and
OFL-1.1 are OSI-approved; CC-BY-SA is not an OSI software licence. To avoid shipping
that artwork, this spike removes the entire stock web UI in the installation
layer and exercises Kasm's WebSocket server using its own small protocol client.
The downloaded `.deb` is a read-only build mount, not a copied image layer.
A production viewer must use audited MPL core code with our own UI assets.

Proving commands (after `./spikes/s0-5-live-view/build.sh`):

```sh
docker run --rm 127.0.0.1:5001/opencrane/s035:spike \
  dpkg-query -W '-f=${Package}\t${Version}\n'
docker run --rm 127.0.0.1:5001/opencrane/s035:spike sh -c \
  'test -z "$(ls -A /usr/share/kasmvnc/www)"'
docker run --rm 127.0.0.1:5001/opencrane/s035:spike \
  dpkg-query -W '-f=${Package}: ${Status}\n' intel-media-va-driver-non-free
```

The UI directory check exits 0. The driver query prints
`intel-media-va-driver-non-free: unknown ok not-installed`.

Image redistribution still requires the applicable GPL/LGPL source and notices;
this spike retains the source pins and installed notices and does not publish
an image. No non-OSI running component is introduced.
