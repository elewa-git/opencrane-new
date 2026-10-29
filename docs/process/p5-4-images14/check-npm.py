"""Compare npm observations without approving dependency licences or an image."""

import contextlib
import gzip
import hashlib
import importlib.util
import io
import json
import posixpath
import sys
import tarfile
from collections import Counter
from pathlib import Path, PurePosixPath

HERE = Path(__file__).resolve().parent
RECORD = HERE / "npm.json"
RECORD_SHA256 = "bd9a31f59affb6c008b013c57358e52b83075f8dde37c7c36ebcdef20b7de4d1"
REFUSAL = "FAIL npm inventory evidence is missing, changed or unsupported"
NPM = "lib/node_modules/npm/"

try:
    previous = HERE.parent / "p5-4-images6/check-pcre.py"
    specification = importlib.util.spec_from_file_location("pcre", previous)
    pcre = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(pcre)
    checked_bytes = pcre.candidate.checked_bytes
except BaseException:
    print(REFUSAL, file=sys.stderr)
    sys.exit(1)


def read_record():
    return json.loads(checked_bytes(RECORD, RECORD_SHA256))


def read_inventory():
    review = read_record()
    checked_bytes(pcre.candidate.RECORD, review["candidateSha256"])
    compressed = checked_bytes(HERE / "inventory.json.gz", review["inventorySha256"])
    return json.loads(gzip.decompress(compressed))


def safe_path(name):
    path = PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts or "\\" in name:
        raise ValueError("Unsupported archive path")
    if str(path) != name.rstrip("/"):
        raise ValueError("Ambiguous archive path")


def scan(archive, prefix, destination=""):
    rows, contents, seen = [], {}, set()
    for member in archive:
        safe_path(member.name)
        if not member.name.startswith(prefix):
            continue
        name = destination + member.name.removeprefix(prefix)
        relevant = name.startswith(NPM) or name.rstrip("/") == NPM.rstrip("/")
        if not relevant and name not in ("bin/npm", "bin/npx"):
            continue
        if member.isdir():
            continue
        if name in seen:
            raise ValueError("Duplicate npm path")
        seen.add(name)
        if member.isfile():
            data = archive.extractfile(member).read()
            rows.append([name, "file", len(data), hashlib.sha256(data).hexdigest()])
            contents[name] = data
        elif member.issym():
            target = member.linkname
            if target.startswith("/") or "\\" in target:
                raise ValueError("Unsupported npm link")
            resolved = posixpath.normpath(posixpath.dirname(name) + "/" + target)
            if not resolved.startswith(NPM):
                raise ValueError("Escaping npm link")
            rows.append([name, "link", 0, target])
        else:
            raise ValueError("Unsupported npm entry")
    return sorted(rows), contents


def observe(rows, contents):
    packages, notices = [], []
    for name, data in sorted(contents.items()):
        if name.endswith("/package.json"):
            metadata = json.loads(data)
            packages.append([name, metadata.get("name"), metadata.get("version"),
                             metadata.get("license")])
        basename = PurePosixPath(name).name.lower()
        if basename.startswith(("license", "licence", "notice", "copying", "copyright")):
            notices.append([name, hashlib.sha256(data).hexdigest()])
    return {"files": sorted(rows), "packages": packages, "notices": notices}


def check_tree(rows, contents, expected):
    observed = observe(rows, contents)
    for field, values in observed.items():
        required = expected[field]
        actual_rows = Counter(json.dumps(row, sort_keys=True) for row in values)
        expected_rows = Counter(json.dumps(row, sort_keys=True) for row in required)
        if actual_rows != expected_rows:
            raise ValueError("npm paths, packages or notices changed")
    # Hash bytes again so callers cannot pair changed contents with unchanged file rows.
    content_rows, file_rows = [], []
    for name, data in contents.items():
        content_rows.append((name, "file", len(data), hashlib.sha256(data).hexdigest()))
    for row in rows:
        if row[1] == "file":
            file_rows.append(tuple(row))
    if Counter(content_rows) != Counter(file_rows):
        raise ValueError("npm contents changed")
    metadata = json.loads(contents[NPM + "package.json"])
    return metadata["version"]


def check_archive(path, prefix, expected, destination=""):
    with tarfile.open(path, mode="r|*") as archive:
        rows, contents = scan(archive, prefix, destination)
    return check_tree(rows, contents, expected)


def check_layers(path, expected, observed_expected=None):
    rows, contents, members = [], {}, {}
    with tarfile.open(path) as archive:
        for member in archive:
            safe_path(member.name)
            if member.isdir():
                continue
            if not member.isfile() or member.name in members:
                raise ValueError("Unsupported outer archive entry")
            members[member.name] = member
        manifest = json.load(archive.extractfile(members["manifest.json"]))
        if len(manifest) != 1:
            raise ValueError("Require one candidate image")
        for layer_name in manifest[0]["Layers"]:
            safe_path(layer_name)
            with tarfile.open(fileobj=archive.extractfile(members[layer_name]), mode="r|*") as layer:
                found, data = scan(layer, "usr/local/")
            rows.extend(found)
            contents.update(data)
    if observed_expected is not None and observe(rows, contents) != observed_expected:
        raise ValueError("Candidate npm observations changed")
    check_tree(rows, contents, expected)


def check_sources(upstream, git_archive, inventory):
    with tarfile.open(fileobj=io.BytesIO(git_archive), mode="r|*") as archive:
        rows, contents = scan(archive, "deps/", "lib/node_modules/")
    check_tree(rows, contents, inventory["source"])
    check_archive(upstream / "node-v22.23.1.tar.xz", "node-v22.23.1/deps/",
                  inventory["source"], "lib/node_modules/")
    version = check_archive(upstream / "node-v22.23.1-linux-x64.tar.xz",
                            "node-v22.23.1-linux-x64/", inventory["official"])
    if version != read_record()["npmVersion"]:
        raise ValueError("npm version differs from authenticated bytes")


def check_evidence(directory, upstream):
    inventory = read_inventory()
    # Authenticate retained files before reading any archive or Git content.
    pcre.check_upstream(upstream)
    git_archive = pcre.run_checked(["git", "-C", str(upstream / "upstream"),
                                   "archive", pcre.COMMIT, "deps/npm"])
    check_sources(upstream, git_archive, inventory)
    record = pcre.candidate.checker.read_json(pcre.candidate.RECORD)
    pcre.check_candidate(record, directory)
    check_layers(directory / "candidate.tar", inventory["official"], inventory["candidate"])


def main(arguments):
    try:
        if len(arguments) != 2:
            raise ValueError("Pass candidate and upstream evidence directories")
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            check_evidence(Path(arguments[0]).resolve(), Path(arguments[1]).resolve())
        print("PASS npm inventory: exact source, official files and every candidate layer")
        print("PARTIAL grants, copied code, missing metadata and source differences BLOCKED")
    except BaseException:
        # Withhold paths, parser errors and dependency output for every refusal.
        print(REFUSAL, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
