"""Check local candidate evidence without changing the approved image review."""

import hashlib
import importlib.util
import json
import lzma
import re
import subprocess
import sys
import tarfile
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
RECORD = Path(__file__).with_name("candidate.json")
FILES = {"source.tar", "candidate.tar", "scan.json", "inspect.json", "installed.tsv",
         "node-LICENSE", "bookworm-InRelease", "bookworm-Packages.xz",
         "debian-archive-keyring.gpg"}
specification = importlib.util.spec_from_file_location(
    "package_licences", ROOT / "infra/package/check-licences.py")
checker = importlib.util.module_from_spec(specification)
specification.loader.exec_module(checker)
OSI = set(checker.read_json(ROOT / "infra/package/osi-licences.json"))


def checked_bytes(path, expected):
    contents = Path(path).read_bytes()
    if hashlib.sha256(contents).hexdigest() != expected:
        raise ValueError("Evidence bytes changed")
    return contents


def inventory(record):
    path = ROOT / "infra/package/licence-inventory.json"
    baseline = json.loads(checked_bytes(path, record["baselineSha256"]))
    entries = baseline["images"]["server"]["artifacts"]
    for removed in record["remove"]:
        matches = []
        for entry in entries:
            if entry[:3] == removed:
                matches.append(entry)
        if len(matches) != 1:
            raise ValueError("Candidate removal must identify one reviewed entry")
        entries.remove(matches[0])
    entries.extend(record["add"])
    packages = checker.parse_debian_main_packages(checker.BOOKWORM_MAIN)
    for entry in entries:
        checker.check_entry(entry, OSI, packages)
    if len(entries) != record["components"]:
        raise ValueError("Candidate component count changed")
    return entries


def check_identity(record, scan, inspection):
    revision = record["sourceRevision"]
    image = inspection[0]
    labels = image["Config"]["Labels"]
    metadata = scan["source"]["metadata"]
    if len(inspection) != 1 or image["Id"] != record["localIndexDigest"]:
        raise ValueError("Candidate inspection differs from its index")
    if labels.get("org.opencontainers.image.revision") != revision:
        raise ValueError("Candidate source label differs")
    if scan["source"]["type"] != "image":
        raise ValueError("Candidate scan must describe an image")
    if metadata["imageID"] != record["configurationDigest"]:
        raise ValueError("Candidate scan differs from its configuration")
    if metadata["labels"].get("org.opencontainers.image.revision") != revision:
        raise ValueError("Candidate scan source differs")
    scope = scan["descriptor"]["configuration"]["search"]["scope"]
    if scope != "all-layers":
        raise ValueError("Candidate scan must include every shipped layer")


def main_packages(release, index):
    checksum = hashlib.sha256(index).hexdigest()
    expected = f"{checksum} {len(index)} main/binary-amd64/Packages.xz"
    sha256_section = release.split("SHA256:\n", 1)[1]
    lines = sha256_section.splitlines()
    records = set()
    for line in lines:
        if line and not line.startswith(" "):
            break
        records.add(" ".join(line.split()))
    if expected not in records:
        raise ValueError("Debian main index differs from the signed release")
    packages = set()
    index_bytes = lzma.decompress(index)
    index_text = index_bytes.decode()
    paragraphs = index_text.split("\n\n")
    for paragraph in paragraphs:
        fields = {}
        for line in paragraph.splitlines():
            if line.startswith(("Package: ", "Version: ")):
                name, value = line.split(": ", 1)
                fields[name] = value
        if "Package" in fields and "Version" in fields:
            packages.add((fields["Package"], fields["Version"]))
    return packages


def check_installed(installed, packages, scanned):
    found = set()
    for line in installed.splitlines():
        name, version = line.split("\t")
        found.add((name, version))
    if found != scanned or not found or not found.issubset(packages):
        raise ValueError("Installed package versions differ from scanned Debian main contents")


def check_archive(record, path):
    with tarfile.open(path) as archive:
        manifest = json.load(archive.extractfile("manifest.json"))
        if len(manifest) != 1:
            raise ValueError("Candidate archive must contain one image")
        configuration = archive.extractfile(manifest[0]["Config"]).read()
        digest = "sha256:" + hashlib.sha256(configuration).hexdigest()
        if digest != record["configurationDigest"]:
            raise ValueError("Candidate archive configuration differs")
        labels = json.loads(configuration)["config"]["Labels"]
        if labels["org.opencontainers.image.revision"] != record["sourceRevision"]:
            raise ValueError("Candidate archive source differs")
        found = {}
        for layer_path in manifest[0]["Layers"]:
            with archive.extractfile(layer_path) as stream:
                with tarfile.open(fileobj=stream, mode="r|*") as layer:
                    for member in layer:
                        path = member.name.lstrip("/")
                        if path in record["shippedFiles"] and member.isfile():
                            contents = layer.extractfile(member)
                            found[path] = hashlib.file_digest(contents, "sha256").hexdigest()
        if found != record["shippedFiles"]:
            raise ValueError("Candidate shipped notices or package bytes differ")
        if found["usr/local/LICENSE"] != record["files"]["node-LICENSE"]:
            raise ValueError("Candidate Node notice differs from the archived notice")
        index = json.load(archive.extractfile("index.json"))
        descriptors = index["manifests"]
        if len(descriptors) != 1 or descriptors[0]["digest"] != record["localIndexDigest"]:
            raise ValueError("Candidate archive index differs")


def check_debian(directory, scan):
    signature = subprocess.run(
        ["gpgv", "--keyring", str(directory / "debian-archive-keyring.gpg"),
         "--output", "-", str(directory / "bookworm-InRelease")],
        capture_output=True, check=False)
    if signature.returncode != 0:
        raise ValueError("Debian release signature refused")
    index = (directory / "bookworm-Packages.xz").read_bytes()
    packages = main_packages(signature.stdout.decode(), index)
    installed = (directory / "installed.tsv").read_text(encoding="utf-8")
    scanned = set()
    for item in scan["artifacts"]:
        if item["type"] == "deb":
            scanned.add((item["name"], item["version"]))
    check_installed(installed, packages, scanned)
    return len(scanned)


def check_node_sections(notices, contents):
    sections = re.split(rb"(?m)^- ", contents)[1:]
    expected = []
    for section in sections:
        lines = section.splitlines()
        heading = lines[0].decode()
        digest = hashlib.sha256(b"- " + section).hexdigest()
        expected.append((heading, digest, "NOT RUN"))
    listed = Counter(tuple(row) for row in notices["nodeSections"])
    if not expected or listed != Counter(expected):
        raise ValueError("Node notice sections are missing, changed or await separate approval")


def check_evidence(record, directory):
    if set(record["files"]) != FILES:
        raise ValueError("Candidate evidence list is incomplete")
    notice_bytes = checked_bytes(RECORD.with_name("notices.json"), record["noticesSha256"])
    notices = json.loads(notice_bytes)
    for filename, checksum in record["files"].items():
        checked_bytes(directory / filename, checksum)
    check_node_sections(notices, (directory / "node-LICENSE").read_bytes())
    entries = inventory(record)
    scan_path = directory / "scan.json"
    scan = checker.read_json(scan_path)
    inspection = checker.read_json(directory / "inspect.json")
    check_identity(record, scan, inspection)
    check_archive(record, directory / "candidate.tar")
    checker.check_scan("candidate", entries, scan_path, OSI)
    debian_count = check_debian(directory, scan)
    print(f"PASS candidate inventory: {len(entries)} components; {debian_count} Debian main")
    print("PARTIAL bundled declaration review; promotion requires separate source-bound R3 evidence")


if __name__ == "__main__":
    try:
        if len(sys.argv) != 2:
            raise ValueError("Pass the local evidence directory")
        check_evidence(checker.read_json(RECORD), Path(sys.argv[1]).resolve())
    except (KeyError, ValueError, OSError, TypeError, IndexError, AttributeError, lzma.LZMAError,
            tarfile.TarError):
        # Withhold local paths, dependency output and input values on refusal.
        print("FAIL candidate evidence is missing or changed", file=sys.stderr)
        sys.exit(1)
