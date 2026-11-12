#!/usr/bin/env python3
"""Collect the reviewed source notices for the static object-store binary."""

import hashlib
import io
import json
import sys
import urllib.request
import zipfile
from pathlib import Path


def require_hash(data, expected):
    if hashlib.sha256(data).hexdigest() != expected:
        raise ValueError("Object-store source notice changed")


def download(url):
    with urllib.request.urlopen(url, timeout=60) as response:
        data = response.read(100 * 1024 * 1024 + 1)
    if len(data) > 100 * 1024 * 1024:
        raise ValueError("Object-store source is oversized")
    return data


def collect(module, destination):
    archive = None
    prefix = module["name"] + "@" + module["version"] + "/"
    if "zipSha256" in module:
        data = download(module["url"])
        require_hash(data, module["zipSha256"])
        archive = zipfile.ZipFile(io.BytesIO(data))
    if "sourceHeader" in module:
        source = module["sourceHeader"]
        source_bytes = archive.read(prefix + source["file"])
        require_hash(source_bytes, source["sha256"])
        header = source_bytes.split(b"\n\n", 1)[0]
        (destination / (source["sha256"] + "-header")).write_bytes(header)
    for notice in module["notices"]:
        if "noticeSource" in module:
            data = download(module["noticeSource"])
        else:
            data = archive.read(prefix + notice["file"])
        require_hash(data, notice["sha256"])
        # Name files by their checked bytes. Source paths never select an output path.
        (destination / notice["sha256"]).write_bytes(data)
    if archive is not None:
        archive.close()


def main():
    if len(sys.argv) != 2:
        raise ValueError("Pass one new output directory")
    destination = Path(sys.argv[1])
    destination.mkdir(mode=0o700)
    source = Path(__file__).with_name("object-notices.json")
    modules = json.loads(source.read_text(encoding="utf-8"))
    for module in modules:
        collect(module, destination)
    (destination / "inventory.json").write_bytes(source.read_bytes())
    print("PASS object-store notices match the reviewed source hashes")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, zipfile.BadZipFile):
        sys.stderr.write("Object-store notice preparation refused\n")
        sys.exit(1)
