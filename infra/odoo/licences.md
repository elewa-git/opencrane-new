# Odoo fixture runtime licence review

Reviewed 3 October 2026 against the pinned Community source and actual amd64
images. Odoo's root LICENSE and Community manifests use **LGPL-3.0-or-later**.
No Enterprise source or installed Enterprise module is included. Odoo's base
catalogue contains offers for Enterprise apps; those are metadata, not add-ons.
Our scripts remain **AGPL-3.0-or-later** under the repository licence.

`runtime-licences.json.gz` is the complete reviewed package inventory, including
versions, architectures, exact signed Debian main archive matches, SHA-256 of
each installed copyright file, its full text and Odoo's notice/manifest inventory.
The archive also records application licences and bundled-component reasons.
Decompress it with Python or `gzip -dc` to inspect individual entries. It contains
no credentials. `licences.py` checks actual dpkg state and notices against this
review; a version, archive, copyright or module-licence change fails startup.
The signed apt-index collector is reused from `apps/computer`, unchanged.

## Application layer

Python **3.13.5** uses the PSF/Python licence stack, accepted under the owner’s
Python rule. PostgreSQL **17.11** uses the PostgreSQL licence; its common tooling
uses GPL-2. The loopback relay is Debian's **socat**, GPL-2 with its OpenSSL
exception. All Python packages come from the pinned Debian main snapshot, with
no pip/npm installs, downloaded wheels or proprietary binaries.

Primary licences checked in the installed Debian copyright texts:

| Licence | Python packages (Debian `python3-` prefix omitted) |
| --- | --- |
| MIT / Expat | asn1crypto, attr, cbor2, cffi-backend, charset-normalizer, docopt, et-xmlfile, inflect, jaraco.context, jaraco.functools, libsass, magic, more-itertools, ofxparse, openpyxl, platformdirs, polib, soupsieve, typeguard, urllib3 |
| BSD-2 / BSD-3 | babel, bs4, cached-property, dateutil, decorator, freetype, gevent, idna, isodate, jinja2, lxml, lxml-html-clean, markupsafe, passlib, psutil, pypdf, qrcode, reportlab, rlpycairo, usb, werkzeug, xlrd, xlsxwriter, xlwt, zeep |
| Apache-2.0 | bcrypt, cryptography (also MIT), freezegun, geoip2, maxminddb, openssl, requests, requests-file, requests-toolbelt, vobject (also MIT) |
| LGPL-2.1-or-later / LGPL-3.0-or-later | autocommand, chardet, num2words, psycopg2 (OpenSSL exception), stdnum |
| PSF / Python | defusedxml, greenlet (also MIT), ldap, legacycrypt, serial, typing-extensions |
| HPND | pil/Pillow; the retained PIL grant is the owner-approved HPND variant |
| MIT | pytz and tz, including the public-domain timezone tables |
| Apache-2.0 / BSD-3 | pkg-resources (setuptools) |
| BSD-3 / Apache-2.0 | rjsmin (with bundled MIT/LGPL pieces) |
| ZPL-2.1 / BSD-2 | roman, zope.event, zope.interface |
| Public domain, with BSD-2 / BSD-3 / ZPL-2.1 exceptions | docutils; scoped dev-fixture exception below |

Docutils is required by Odoo's module loader. Its [upstream copying
terms](https://docutils.sourceforge.io/COPYING.html) confirm the primary
public-domain dedication. The [orchestrator decision on #52](https://github.com/elewa-git/opencrane-new/issues/52#issuecomment-5966808505)
accepts Debian main `python3-docutils` as a scoped exception for this dev-only
fixture. It represents a customer's external ERP and is never built into,
shipped in or run inside a silo. Application licence qualification is **PASS
with this scoped exception**. Nothing outside `infra/odoo` may depend on these
fixture images; the silo application licence rule remains unchanged.

The bundled notices are not silently treated as OSI licences:

| Component | Notice and reason |
| --- | --- |
| Docutils | Standalone required Python dependency with a public-domain primary notice; not OSI-approved and not an OSI package's bundled part. HTML writer, smartquotes and maths code carry BSD-2/BSD-3, with ZPL code. The full mixed-package notice is retained. Accepted only under the scoped dev-fixture exception above; application licence qualification is PASS with that exception. |
| Python interpreter | Retained PSF/BeOpen/CNRI/CWI stack; bundled BSD, MIT, Apache, HPND, Tcl and public-domain code has permissive copying/modification/distribution grants in the full copyright text. |
| PostgreSQL regex and utilities | Tcl and Henry Spencer regex grants; Custom-pg_dump permits any use with its notice; Custom-Unicode permits modification/distribution; double-metaphone and nagaysau-ishii retain permissive notice/disclaimer grants. |
| Passlib | BEER-WARE md5_crypt permits any use with notice; Aki Yoshida DES permits commercial/non-commercial copying and modification; Damien Miller Blowfish uses ISC terms. |
| BeautifulSoup/greenlet | Public-domain parts and greenlet CC0 support files have no commercial-use restrictions. Their notices remain alongside the OSI parts. |
| ReportLab | BSD-3 grant labelled ReportLab-License; Vera fonts use Bitstream terms, DarkGarden GPL with embedding exception, callig15 permits modification/copying/distribution under the Vanroose notice. |
| Pillow, freetype, lxml | HPND/PIL and ElementTree terms, OFL/Bitstream example fonts and permissive supporting code; system JPEG/FreeType libraries have their separate Debian main notices. Two unused unlicensed lxml Schematron stylesheets are removed, as in the computer image. |
| idna, charset-normalizer, maxminddb | Unicode tables and public-domain/CC-BY-SA source data or test data; the latter are source-package notices, not an extra runtime database download. |
| Werkzeug | CC-BY-SA debugger icon notices and Debian's GAP grant are retained alongside BSD-3 code. |
| Chardet, requests, zeep | Upstream sample-data notices, BSD theme notice and W3C schema notices retained; no undocumented new sample data is downloaded. |
| xlrd/xlwt | BSD primary grant with retained earlier advertising/acknowledgement terms; these are DFSG-free bundled notices, not a source-available restriction. |

## Community source and operating system

Odoo's complete source is pinned by commit and tar SHA-256. Its root licence
covers original code, with retained file notices for incorporated parts. The
review includes all Community manifests and dedicated notices, including unused
Community apps present in the image; only `sale` and its 54-module dependency/auto
installation set are installed. No Enterprise repository is fetched.

Bundled source libraries use MIT (Bootstrap, jQuery, FullCalendar, Popper,
Signature Pad, Prism, stacktrace, cropper, diff2html, webgl-image-filter, chart libraries),
BSD (Ace, WebAuthn), Apache-2.0 (pdf.js, ZXing, idb-keyval,
MediaPipe wrapper), Apache-2.0/MPL-2.0 (DOMPurify), LGPL (LAME) or Odoo's LGPL
(Owl and original libraries). The SFU notice names its MIT/ISC dependencies.
Fonts retain Apache-2.0, OFL and permissive font notices; pdf.js CMaps retain BSD;
the ICC colour profile explicitly permits copying, embedding, alteration and sale.
The upstream Debian copyright manifest also records MIT appdirs, PSF lru and
other incorporated sources. Every dedicated notice is hashed in the inventory.
The pinned source contains no shipped `py.js` WTFPL file referenced by the older
upstream Debian copyright manifest.

The OS layer is **Debian main only**, verified against trusted signed snapshot
indexes. All OS package copyright texts are retained in the inventory. Debian
main's DFSG-free public-domain, CC0, Unicode, X11, HPND, OFL, FreeType and IJG
notices are accepted under the owner’s OS-layer rule. No contrib/non-free, BUSL,
SSPL, KLv1, Enterprise, or other source-available component is introduced.
This is a licence review of a dev fixture, not a vulnerability-scan receipt.

See [evidence](../../docs/process/odoo-fixture-evidence.md) for the qualified image
identifiers, checks and explicit untested conditions.
