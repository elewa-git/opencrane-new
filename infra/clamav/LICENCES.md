# Reviewed scanner runtime licences

2 October 2026. Engine/signature source image:
`clamav/clamav-debian@sha256:14e2e0805c6a5ff6728ea591c05565e0f0954d93e8701919012c3a8c44e20674`.
Runtime is built by [Dockerfile](Dockerfile), not deployed from that upstream image.

ClamAV 1.5.2 is GPL-2.0 with the upstream OpenSSL linking exception.
[Upstream notices](https://github.com/Cisco-Talos/clamav/tree/clamav-1.5.2/COPYING)
and its [component list](https://github.com/Cisco-Talos/clamav/blob/clamav-1.5.2/README.md)
identify the bundled parts below. OSI licences are accepted as application parts;
public-domain notices are accepted only as DFSG-free parts bundled in ClamAV.

| Bundled part | Notice / decision |
| --- | --- |
| libmspack | LGPL-2.1; OSI-approved |
| YARA | Apache-2.0 in this pinned source; OSI-approved |
| bzip2, file, OpenBSD regex, strtol/stroul | BSD variants; OSI-approved |
| curl, getopt, pngcheck | curl/MIT/X11; OSI-approved or DFSG-free permissive notice inside GPL ClamAV |
| zlib | Zlib; OSI-approved |
| LLVM (optional upstream component) | University of Illinois/NCSA; OSI-approved |
| PCRE2 | BSD-3-Clause; OSI-approved |
| LZMA/7z | public domain; DFSG-free bundled parser, accepted under the application-component rule |
| Rust libraries | MIT/Apache-2.0; OSI-approved; unused static build archive removed |
| UnRAR and its interface | restricted reverse-engineering licence; rejected and removed before the final scratch stage |

Both Debian source entries in the inspected image name only `Components: main`;
there is no `contrib` or `non-free` source. System libraries and tools belong to
that DFSG-free OS layer. ClamAV's signature databases are the pinned operational
data, main 63 / daily 28046 / bytecode 339. FreshClam writes a separate dev-box
candidate and never changes those deployed databases at startup.
