#!/usr/bin/env python3
"""Check the reviewed contents of each pinned package image."""

import json
import hashlib
import re
import sys
from collections import Counter
from pathlib import Path

PACKAGE = Path(__file__).parent
ROLES = ("server", "web", "postgres", "nats", "openfga", "computer")
APPLICATION_TYPES = {"npm", "go-module", "binary"}

# Require a new index review when either Debian-based image changes.
INDEX_IMAGE_PINS = {
    "server": (
        "k3d-ocn-registry:5000/opencrane/package@sha256:"
        "0a92219795920c6ebf4fd054b2331a69b6538a30a2d30c723591e4c8c25ef15a"
    ),
    "web": (
        "k3d-ocn-registry:5000/opencrane/package@sha256:"
        "0a92219795920c6ebf4fd054b2331a69b6538a30a2d30c723591e4c8c25ef15a"
    ),
    "postgres": (
        "postgres:17@sha256:"
        "d74eeac9a635390a49bc21bd49fccd973de707e2a53a76ac49b552b8712ec46f"
    ),
}

# Keep only versions found in the signed main index for each base image release.
BOOKWORM_MAIN = """\
adduser 3.134
apt 2.6.1
base-files 12.4+deb12u15
base-passwd 3.6.1
bash 5.2.15-2+b13
bsdutils 1:2.38.1-5+deb12u3
coreutils 9.1-1
dash 0.5.12-2
debconf 1.5.82
debian-archive-keyring 2023.3+deb12u2
debianutils 5.7-0.5~deb12u1
diffutils 1:3.8-4
dpkg 1.21.23
e2fsprogs 1.47.0-2+b2
findutils 4.9.0-4
gcc-12-base 12.2.0-14+deb12u1
gpgv 2.2.40-1.1+deb12u2
grep 3.8-5
gzip 1.12-1
hostname 3.23+nmu1
init-system-helpers 1.65.2+deb12u1
libacl1 2.3.1-3
libapt-pkg6.0 2.6.1
libattr1 1:2.5.1-4
libaudit-common 1:3.0.9-1
libaudit1 1:3.0.9-1
libblkid1 2.38.1-5+deb12u3
libbz2-1.0 1.0.8-5+b1
libc-bin 2.36-9+deb12u14
libc6 2.36-9+deb12u14
libcap-ng0 0.8.3-1+b3
libcap2 1:2.66-4+deb12u3+b1
libcom-err2 1.47.0-2+b2
libcrypt1 1:4.4.33-2
libdb5.3 5.3.28+dfsg2-1
libdebconfclient0 0.270
libext2fs2 1.47.0-2+b2
libffi8 3.4.4-1
libgcc-s1 12.2.0-14+deb12u1
libgcrypt20 1.10.1-3+deb12u1
libgmp10 2:6.2.1+dfsg1-1.1
libgnutls30 3.7.9-2+deb12u7
libgpg-error0 1.46-1
libhogweed6 3.8.1-2
libidn2-0 2.3.3-1+b1
liblz4-1 1.9.4-1
liblzma5 5.4.1-1+deb12u1
libmd0 1.0.4-2
libmount1 2.38.1-5+deb12u3
libnettle8 3.8.1-2
libp11-kit0 0.24.1-2
libpam-modules 1.5.2-6+deb12u2
libpam-modules-bin 1.5.2-6+deb12u2
libpam-runtime 1.5.2-6+deb12u2
libpam0g 1.5.2-6+deb12u2
libpcre2-8-0 10.42-1
libseccomp2 2.5.4-1+deb12u1
libselinux1 3.4-1+b6
libsemanage-common 3.4-1
libsemanage2 3.4-1+b5
libsepol2 3.4-2.1
libsmartcols1 2.38.1-5+deb12u3
libss2 1.47.0-2+b2
libstdc++6 12.2.0-14+deb12u1
libsystemd0 252.39-1~deb12u2
libtasn1-6 4.19.0-2+deb12u1
libtinfo6 6.4-4
libudev1 252.39-1~deb12u2
libunistring2 1.0-2
libuuid1 2.38.1-5+deb12u3
libxxhash0 0.8.1-1
libzstd1 1.5.4+dfsg2-5
login 1:4.13+dfsg1-1+deb12u2
logsave 1.47.0-2+b2
mawk 1.3.4.20200120-3.1
mount 2.38.1-5+deb12u3
ncurses-base 6.4-4
ncurses-bin 6.4-4
passwd 1:4.13+dfsg1-1+deb12u2
perl-base 5.36.0-7+deb12u3
sed 4.9-1+deb12u1
sysvinit-utils 3.06-4
tar 1.34+dfsg-1.2+deb12u1
tzdata 2026b-0+deb12u1
usr-is-merged 37~deb12u1
util-linux 2.38.1-5+deb12u3
util-linux-extra 2.38.1-5+deb12u3
zlib1g 1:1.2.13.dfsg-1
"""

TRIXIE_MAIN = """\
adduser 3.152
apt 3.0.3
base-files 13.8+deb13u7
base-passwd 3.6.7
bash 5.2.37-2+b10
bsdutils 1:2.41.5-0+deb13u1
coreutils 9.7-3
dash 0.5.12-12
debconf 1.5.91
debian-archive-keyring 2025.1
debianutils 5.23.2
diffutils 1:3.10-4
dirmngr 2.4.7-21+deb13u1+b5
dpkg 1.22.22
findutils 4.10.0-3
gcc-14-base 14.2.0-19
gnupg 2.4.7-21+deb13u1
gnupg-l10n 2.4.7-21+deb13u1
gpg 2.4.7-21+deb13u1+b5
gpg-agent 2.4.7-21+deb13u1+b5
gpgconf 2.4.7-21+deb13u1+b5
gpgsm 2.4.7-21+deb13u1+b5
grep 3.11-4
gzip 1.13-1+deb13u1
hostname 3.25
init-system-helpers 1.69~deb13u1
less 668-1
libacl1 2.3.2-2+b1
libapt-pkg7.0 3.0.3
libassuan9 3.0.2-2
libattr1 1:2.5.2-3
libaudit-common 1:4.0.2-2+deb13u1
libaudit1 1:4.0.2-2+deb13u1
libblkid1 2.41.5-0+deb13u1
libbsd0 0.12.2-2
libbz2-1.0 1.0.8-6
libc-bin 2.41-12+deb13u4
libc-l10n 2.41-12+deb13u4
libc6 2.41-12+deb13u4
libcap-ng0 0.8.5-4+b1
libcap2 1:2.75-10+deb13u1+b3
libcom-err2 1.47.2-3+b12
libcrypt1 1:4.4.38-1
libdb5.3t64 5.3.28+dfsg2-9
libdebconfclient0 0.280
libedit2 3.1-20250104-1
libffi8 3.4.8-2
libgcc-s1 14.2.0-19
libgcrypt20 1.11.0-7+deb13u1
libgdbm-compat4t64 1.24-2
libgdbm6t64 1.24-2
libgmp10 2:6.3.0+dfsg-3
libgnutls30t64 3.8.9-3+deb13u4
libgpg-error0 1.51-4
libgssapi-krb5-2 1.21.3-5+deb13u1
libhogweed6t64 3.10.1-1
libicu76 76.1-4
libidn2-0 2.3.8-2
libjson-perl 4.10000-1
libk5crypto3 1.21.3-5+deb13u1
libkeyutils1 1.6.3-6
libkrb5-3 1.21.3-5+deb13u1
libkrb5support0 1.21.3-5+deb13u1
libksba8 1.6.7-2+b1
liblastlog2-2 2.41.5-0+deb13u1
libldap2 2.6.10+dfsg-1
libllvm19 1:19.1.7-3+b1
liblz4-1 1.10.0-4
liblzma5 5.8.1-1+deb13u1
libmd0 1.1.0-2+b1
libmount1 2.41.5-0+deb13u1
libncursesw6 6.5+20250216-2
libnettle8t64 3.10.1-1
libnpth0t64 1.8-3
libnss-wrapper 1.1.16-1
libp11-kit0 0.25.5-3
libpam-modules 1.7.0-5
libpam-modules-bin 1.7.0-5
libpam-runtime 1.7.0-5
libpam0g 1.7.0-5
libpcre2-8-0 10.46-1~deb13u2
libperl5.40 5.40.1-6+deb13u1
libproc2-0 2:4.0.4-9
libreadline8t64 8.2-6
libsasl2-2 2.1.28+dfsg1-9
libsasl2-modules-db 2.1.28+dfsg1-9
libseccomp2 2.6.0-2
libselinux1 3.8.1-1
libsemanage-common 3.8.1-1
libsemanage2 3.8.1-1
libsepol2 3.8.1-1
libsmartcols1 2.41.5-0+deb13u1
libsqlite3-0 3.46.1-7+deb13u2
libssl3t64 3.5.7-1~deb13u2
libstdc++6 14.2.0-19
libsystemd0 257.13-1~deb13u1
libtasn1-6 4.20.0-2+deb13u1
libtext-charwidth-perl 0.04-11+b4
libtext-wrapi18n-perl 0.06-10
libtinfo6 6.5+20250216-2
libudev1 257.13-1~deb13u1
libunistring5 1.3-2
libuuid1 2.41.5-0+deb13u1
libxml2 2.12.7+dfsg+really2.9.14-2.1+deb13u3
libxslt1.1 1.1.35-1.2+deb13u3
libxxhash0 0.8.3-2
libz3-4 4.13.3-1
libzstd1 1.5.7+dfsg-1
locales 2.41-12+deb13u4
login 1:4.16.0-2+really2.41.5-0+deb13u1
login.defs 1:4.17.4-2
mawk 1.3.4.20250131-1
mount 2.41.5-0+deb13u1
ncurses-base 6.5+20250216-2
ncurses-bin 6.5+20250216-2
netbase 6.5
openssl 3.5.7-1~deb13u2
openssl-provider-legacy 3.5.7-1~deb13u2
passwd 1:4.17.4-2
perl 5.40.1-6+deb13u1
perl-base 5.40.1-6+deb13u1
perl-modules-5.40 5.40.1-6+deb13u1
pinentry-curses 1.3.1-2
procps 2:4.0.4-9
readline-common 8.2-6
sed 4.9-2+deb13u1
sensible-utils 0.0.25
sqv 1.3.0-3+b2
ssl-cert 1.1.3
sysvinit-utils 3.14-4
tar 1.35+dfsg-3.1
tzdata 2026c-0+deb13u1
ucf 3.0052
util-linux 2.41.5-0+deb13u1
xz-utils 5.8.1-1+deb13u1
zlib1g 1:1.3.dfsg+really1.3.1-1+b1
zstd 1.5.7+dfsg-1
"""



def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def parse_debian_main_packages(index_text):
    packages = set()
    for line in index_text.splitlines():
        name, version = line.split(" ", 1)
        packages.add((name, version))
    return packages


def check_entry(entry, osi_ids, debian_main_packages, pgdg_packages=None):
    if len(entry) not in (5, 6):
        raise ValueError("Inventory entry needs type, name, version, licence and evidence")
    package_type, name, version, licence, evidence = entry[:5]
    if not all(isinstance(value, str) and value for value in entry):
        raise ValueError("Inventory entry has an empty field")
    if package_type == "deb":
        if len(entry) == 6 and entry[5] == "PGDG":
            reviewed_licence = (pgdg_packages or {}).get((name, version))
            if reviewed_licence is None:
                raise ValueError(f"Operating-system package is absent from PGDG: {name} {version}")
            if licence != reviewed_licence or licence not in osi_ids:
                raise ValueError(f"PGDG package has no matching OSI licence review: {name}")
        elif len(entry) == 5 and licence == "Debian-main":
            if (name, version) not in debian_main_packages:
                raise ValueError(
                    f"Operating-system package is absent from Debian main: {name} {version}")
        else:
            raise ValueError(f"Operating-system package has no Debian main or PGDG review: {name}")
    elif package_type in APPLICATION_TYPES:
        if len(entry) != 5:
            raise ValueError(f"Application package has an extra source label: {name}")
        if licence not in osi_ids:
            raise ValueError(f"Unknown or non-OSI application licence: {name} {licence}")
    else:
        raise ValueError(f"Unknown package type: {package_type}")
    return package_type, name, version


def check_declared_licences(item, osi_ids):
    if item["type"] not in APPLICATION_TYPES:
        return
    for declaration in item.get("licenses", []):
        expression = declaration.get("spdxExpression")
        if item["name"] == "type-fest" and expression == "(MIT OR CC0-1.0)":
            continue
        if expression not in osi_ids:
            raise ValueError(f"Unknown or non-OSI scanned licence: {item['name']}")


def check_bundled_notice(notice, osi_ids):
    if len(notice) != 4 or not notice[0] or not notice[2] or not notice[3]:
        raise ValueError("Bundled notice needs a component, source and reason")
    if not notice[1]:
        raise ValueError("Bundled notice has no licence")
    for licence in notice[1]:
        if licence not in osi_ids and licence != "LicenseRef-Public-Domain":
            raise ValueError(f"Unknown or non-free bundled licence: {licence}")


def check_manual_component(component, osi_ids):
    if len(component) != 4 or not all(component):
        raise ValueError("Manual review needs a name, version, licence and evidence")
    if component[2] not in osi_ids:
        raise ValueError(f"Unknown or non-OSI component licence: {component[0]}")
    if component[0] == "kubectl":
        checksum = re.search(r"Download sha256:([a-f0-9]{64})", component[3])
        dockerfile = (PACKAGE / "Dockerfile").read_text(encoding="utf-8")
        if not checksum or f"--checksum=sha256:{checksum.group(1)}" not in dockerfile:
            raise ValueError("kubectl review differs from the downloaded binary")
        if f"/release/{component[1]}/bin/" not in dockerfile:
            raise ValueError("kubectl version differs from the downloaded binary")
    if component[0] == "agentgateway":
        dockerfile = (PACKAGE / "Dockerfile").read_text(encoding="utf-8")
        checksum = component[3].split("sha256:")[-1][:64]
        if not re.fullmatch(r"[a-f0-9]{64}", checksum):
            raise ValueError("agentgateway review has no checksum")
        if f"--checksum=sha256:{checksum}" not in dockerfile:
            raise ValueError("agentgateway review differs from the downloaded binary")


def check_computer_review(image):
    if image["reviewedInventory"] != "apps/computer/licences.json":
        raise ValueError("Computer licence review path changed")
    source = PACKAGE.parent.parent / "apps/computer/licences.json"
    checksum = hashlib.sha256(source.read_bytes()).hexdigest()
    if checksum != image["reviewedInventorySha256"]:
        raise ValueError("Computer licence review changed")
    evidence = read_json(PACKAGE.parent.parent / "apps/computer/evidence.json")
    if evidence["image"] != image["pin"]:
        raise ValueError("Computer licence review covers another image")
    entries = read_json(source)
    if not entries or any(entry["result"] != "PASS" for entry in entries):
        raise ValueError("Computer licence review contains a failed component")
    return len(entries)


def check_scan(role, entries, path, osi_ids):
    scan = read_json(path)
    for item in scan["artifacts"]:
        check_declared_licences(item, osi_ids)
    found = Counter((item["type"], item["name"], item["version"])
                    for item in scan["artifacts"])
    expected = Counter((entry[0], entry[1], entry[2]) for entry in entries)
    if found != expected:
        raise ValueError(f"{role} scan differs from the reviewed inventory")


def check_package_review(reviewed, inventory):
    proof = reviewed.get("natsCluster", {})
    revision = proof.get("sourceRevision", "")
    if not isinstance(revision, str) or not re.fullmatch(r"[a-f0-9]{40}", revision):
        raise ValueError("Package review needs an exact source revision")
    if proof.get("replicas") != 3:
        raise ValueError("Package review needs R3 compatibility proof")
    pin = reviewed["images"]["server"]
    if not re.fullmatch(r"[^\s]+@sha256:[a-f0-9]{64}", pin):
        raise ValueError("Package review needs an immutable image digest")
    for role in ("server", "web"):
        if (reviewed["images"][role] != pin or proof.get(role) != pin or
                inventory["images"][role]["pin"] != pin):
            raise ValueError("Package review covers a different role digest")
    if inventory["images"]["server"].get("sourceRevision") != revision:
        raise ValueError("Package inventory covers a different source revision")
    return proof


def check_package_promotion(reviewed, inventory, inspection, scan_path, revision):
    proof = check_package_review(reviewed, inventory)
    if revision != proof["sourceRevision"]:
        raise ValueError("Package promotion covers a different source revision")
    if not isinstance(inspection, list) or len(inspection) != 1:
        raise ValueError("Package promotion needs one inspected image")
    image = inspection[0]
    labels = image.get("Config", {}).get("Labels") or {}
    if labels.get("org.opencontainers.image.revision") != revision:
        raise ValueError("Package image has a missing or wrong source revision")
    if proof["server"] not in image.get("RepoDigests", []):
        raise ValueError("Package inspection covers a different digest")
    image_id = image.get("Id", "")
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", image_id) or proof.get("imageId") != image_id:
        raise ValueError("Package inspection covers a different image")
    scan = read_json(scan_path)
    if (scan["source"]["type"] != "image" or
            scan["source"]["metadata"]["imageID"] != image_id):
        raise ValueError("Package scan covers a different image")
    if scan["descriptor"]["configuration"]["search"]["scope"] != "all-layers":
        raise ValueError("Package scan must include all shipped layers")
    checksum = hashlib.sha256(Path(scan_path).read_bytes()).hexdigest()
    if proof.get("scanSha256") != checksum:
        raise ValueError("Package scan differs from its reviewed checksum")
    osi_ids = set(read_json(PACKAGE / "osi-licences.json"))
    entries = inventory["images"]["server"]["artifacts"]
    check_scan("server", entries, scan_path, osi_ids)


def main(arguments, promotion=None):
    reviewed = read_json(PACKAGE / "reviewed-images.json")
    inventory = read_json(PACKAGE / "licence-inventory.json")
    if "natsCluster" in reviewed:
        check_package_review(reviewed, inventory)
    if promotion is not None:
        revision, inspection_path = promotion
        if "server" not in arguments or "web" not in arguments:
            raise ValueError("Package promotion needs server and web scans")
        inspection = read_json(inspection_path)
        for role in ("server", "web"):
            check_package_promotion(reviewed, inventory, inspection, arguments[role], revision)
    osi_ids = set(read_json(PACKAGE / "osi-licences.json"))
    pgdg_extract = read_json(PACKAGE / "pgdg-trixie-main.json")
    if pgdg_extract["imagePin"] != INDEX_IMAGE_PINS["postgres"]:
        raise ValueError("PGDG package index was reviewed for a different postgres image")
    pgdg_packages = {}
    for package in pgdg_extract["packages"]:
        key = (package["name"], package["version"])
        if key in pgdg_packages:
            raise ValueError(f"PGDG package appears twice: {package['name']} {package['version']}")
        pgdg_packages[key] = package["licence"]
    bookworm_main = parse_debian_main_packages(BOOKWORM_MAIN)
    trixie_main = parse_debian_main_packages(TRIXIE_MAIN)
    debian_main_by_role = {
        "server": bookworm_main,
        "web": bookworm_main,
        "postgres": trixie_main,
        "nats": set(),
        "openfga": set(),
    }
    if set(inventory["images"]) != set(ROLES):
        raise ValueError("An image is missing from the licence inventory")
    for role in ROLES:
        image = inventory["images"][role]
        if image["pin"] != reviewed["images"][role]:
            raise ValueError(f"{role} licence inventory does not match its image pin")
        if role in INDEX_IMAGE_PINS and image["pin"] != INDEX_IMAGE_PINS[role]:
            raise ValueError(f"Debian main index was reviewed for a different {role} image")
        if role == "computer":
            count = check_computer_review(image)
            print(f"PASS computer: {count} reviewed components")
            continue
        if "sameAs" in image:
            source = inventory["images"][image["sameAs"]]
            if source["pin"] != image["pin"]:
                raise ValueError(f"{role} shares contents with a different image")
            entries = source["artifacts"]
        else:
            entries = image["artifacts"]
        for notice in image.get("bundled", []):
            check_bundled_notice(notice, osi_ids)
        for component in image.get("manual", []):
            check_manual_component(component, osi_ids)
        if not entries:
            raise ValueError(f"{role} has an empty licence inventory")
        for entry in entries:
            reviewed_pgdg = pgdg_packages if role == "postgres" else {}
            check_entry(entry, osi_ids, debian_main_by_role[role], reviewed_pgdg)
        if role in arguments:
            check_scan(role, entries, arguments[role], osi_ids)
        print(f"PASS {role}: {len(entries)} reviewed components")


if __name__ == "__main__":
    try:
        arguments = sys.argv[1:]
        promotion = None
        if arguments and arguments[0] == "--promotion":
            if len(arguments) < 3:
                raise ValueError("Pass source revision and image inspection before ROLE PATH pairs")
            promotion = arguments[1:3]
            arguments = arguments[3:]
        if len(arguments) % 2:
            raise ValueError("Pass scan files as ROLE PATH pairs")
        scans = dict(zip(arguments[::2], arguments[1::2]))
        if set(scans) - set(ROLES):
            raise ValueError("Unknown image role")
        main(scans, promotion)
    except (KeyError, ValueError, OSError, TypeError) as error:
        if promotion is not None:
            print("FAIL package promotion: evidence is missing or does not match", file=sys.stderr)
        else:
            print(f"FAIL package licence review: {error}", file=sys.stderr)
        sys.exit(1)
