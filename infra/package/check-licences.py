#!/usr/bin/env python3
"""Check the reviewed contents of each pinned package image."""

import json
import re
import sys
from collections import Counter
from pathlib import Path

PACKAGE = Path(__file__).parent
ROLES = ("server", "web", "postgres", "nats", "openfga")
APPLICATION_TYPES = {"npm", "go-module", "binary"}


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def check_entry(entry, osi_ids):
    if len(entry) != 5:
        raise ValueError("Inventory entry needs type, name, version, licence and evidence")
    package_type, name, version, licence, evidence = entry
    if not all(isinstance(value, str) and value for value in entry):
        raise ValueError("Inventory entry has an empty field")
    if package_type == "deb":
        if licence != "Debian-main":
            raise ValueError(f"Operating-system package has no Debian main review: {name}")
    elif package_type in APPLICATION_TYPES:
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


def check_scan(role, entries, path, osi_ids):
    scan = read_json(path)
    for item in scan["artifacts"]:
        check_declared_licences(item, osi_ids)
    found = Counter((item["type"], item["name"], item["version"])
                    for item in scan["artifacts"])
    expected = Counter((entry[0], entry[1], entry[2]) for entry in entries)
    if found != expected:
        raise ValueError(f"{role} scan differs from the reviewed inventory")


def main(arguments):
    reviewed = read_json(PACKAGE / "reviewed-images.json")
    inventory = read_json(PACKAGE / "licence-inventory.json")
    osi_ids = set(read_json(PACKAGE / "osi-licences.json"))
    if set(inventory["images"]) != set(ROLES):
        raise ValueError("An image is missing from the licence inventory")
    for role in ROLES:
        image = inventory["images"][role]
        if image["pin"] != reviewed["images"][role]:
            raise ValueError(f"{role} licence inventory does not match its image pin")
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
            check_entry(entry, osi_ids)
        if role in arguments:
            check_scan(role, entries, arguments[role], osi_ids)
        print(f"PASS {role}: {len(entries)} reviewed components")


if __name__ == "__main__":
    try:
        if (len(sys.argv) - 1) % 2:
            raise ValueError("Pass scan files as ROLE PATH pairs")
        scans = dict(zip(sys.argv[1::2], sys.argv[2::2]))
        if set(scans) - set(ROLES):
            raise ValueError("Unknown image role")
        main(scans)
    except (KeyError, ValueError, OSError) as error:
        print(f"FAIL package licence review: {error}", file=sys.stderr)
        sys.exit(1)
