"""Check one source-bound PCRE licence reference without approving an image."""

import hashlib
import importlib.util
import json
import subprocess
import sys
import tarfile
import tempfile
from collections import Counter
from pathlib import Path

RECORD = Path(__file__).with_name("pcre.json")
previous = RECORD.parent.parent / "p5-4-images5/check-node-notices.py"
specification = importlib.util.spec_from_file_location("node_notices", previous)
node = importlib.util.module_from_spec(specification)
specification.loader.exec_module(node)
candidate = node.candidate
VERSION = "22.23.1"
COMMIT = "bd96dfbf0361576724b65322046e2ca9f9609cb9"
SOURCE_PATH = "deps/v8/test/mjsunit/third_party/regexp-pcre/regexp-pcre.js"
BINARY = "93956de2e59480474a7b46571da1651180b1a050cdf32641ebec4ce6e478e068"
REFERENCE = ("105920c94ff5a834680e7e6d4ed5b666df185d6dc04ce7d7992b947b9916299f",
             "V8 PCRE test suite")
INPUTS = {
    "regexp-pcre.js": "ef8e3b495c191bdacfa1e67ef7bb7b70f7ac713c932a008960d83c9d35ed8dbc",
    "node-version.h": "1f855c039d28579c382af6de10a46c6f695085a245182ebd2903e0b26302bb6a",
    "node-LICENSE": node.NODE_NOTICE,
}
FILES = {
    "node-v22.23.1.tar.xz": "b27385d6845089bdb91285d94b06c2a5cf1c37f8173a3c4e10824cc1ffadeaba",
    "node-v22.23.1-linux-x64.tar.xz":
        "9749e988f437343b7fa832c69ded82a312e41a03116d766797ac14f6f9eee578",
    "SHASUMS256.txt.asc": "8bf8cd2085e1c25cc750386c2253715b13867c65e2fa9c9c4abc47967420ec28",
    "node-release-keys.kbx": "610b8d249da3d5733f5a128def2dd0294dbbf5b5713e6ca2529db8db419dee00",
    "node-tag": "970c701965a2487ccaa5978cd9d97d879fe7d51a0aab59fa5672210bab2254dd",
}
GRANTS = [("PCRE basic library", ("BSD-3-Clause",)),
          ("PCRE C++ wrapper", ("BSD-3-Clause",))]
FIELDS = {"status", "method", "references", "nodeVersion", "upstreamCommit", "sourcePath",
          "candidateSha256", "nodeNoticesSha256", "nodeBinarySha256", "files", "declarations"}


def check_review(review, inputs):
    if set(review) != FIELDS or review["status"] != "PARTIAL":
        raise ValueError("PCRE evidence cannot approve the complete image")
    if review["method"] != "reviewed embedded terms":
        raise ValueError("PCRE absence has not been proved")
    expected = (VERSION, COMMIT, SOURCE_PATH, BINARY)
    actual = (review["nodeVersion"], review["upstreamCommit"],
              review["sourcePath"], review["nodeBinarySha256"])
    if actual != expected or review["files"] != FILES:
        raise ValueError("PCRE source version or build inputs differ")
    if review["references"] != [list(REFERENCE)]:
        raise ValueError("PCRE requires its exact reference once")
    candidate.checked_bytes(candidate.RECORD, review["candidateSha256"])
    historical = candidate.checked_bytes(node.RECORD, review["nodeNoticesSha256"])
    for name, digest in INPUTS.items():
        source_digest = hashlib.sha256(inputs[name])
        if source_digest.hexdigest() != digest:
            raise ValueError("PCRE source or notice bytes changed")
    node.check_review(json.loads(historical), inputs["node-LICENSE"])
    grants = []
    for declaration in review["declarations"]:
        candidate.checker.check_bundled_notice(declaration, candidate.OSI)
        if not isinstance(declaration[3], str) or not declaration[3].strip():
            raise ValueError("PCRE grants need an individual reason")
        if declaration[2] != SOURCE_PATH:
            raise ValueError("PCRE terms must identify the reviewed source")
        grants.append((declaration[0], tuple(declaration[1])))
    if Counter(grants) != Counter(GRANTS):
        raise ValueError("PCRE component and licence pairs differ")
    return REFERENCE[1]


def run_checked(arguments):
    result = subprocess.run(arguments, capture_output=True, check=False)
    if result.returncode != 0:
        raise ValueError("PCRE upstream verification failed")
    return result.stdout


def check_upstream(directory):
    for name, digest in FILES.items():
        candidate.checked_bytes(directory / name, digest)
    keyring = str(directory / "node-release-keys.kbx")
    with tempfile.TemporaryDirectory() as temporary:
        output = Path(temporary)
        sums = output / "sums"
        run_checked(["gpgv", "--keyring", keyring, "--output", str(sums),
                     str(directory / "SHASUMS256.txt.asc")])
        entries = {}
        checksum_text = sums.read_text()
        for line in checksum_text.splitlines():
            digest, name = line.split()
            entries[name] = digest
        for name in ("node-v22.23.1.tar.xz", "node-v22.23.1-linux-x64.tar.xz"):
            if entries.get(name) != FILES[name]:
                raise ValueError("PCRE archives differ from the signed release")
        tag = (directory / "node-tag").read_bytes()
        payload, signature = tag.split(b"-----BEGIN PGP SIGNATURE-----", 1)
        if not payload.startswith(f"object {COMMIT}\ntype commit\ntag v{VERSION}\n".encode()):
            raise ValueError("PCRE tag identifies a different version")
        (output / "payload").write_bytes(payload)
        (output / "signature").write_bytes(b"-----BEGIN PGP SIGNATURE-----" + signature)
        run_checked(["gpgv", "--keyring", keyring,
                     str(output / "signature"), str(output / "payload")])
    inputs = {}
    for name, path in (("regexp-pcre.js", SOURCE_PATH),
                       ("node-version.h", "src/node_version.h"), ("node-LICENSE", "LICENSE")):
        inputs[name] = run_checked(["git", "-C", str(directory / "upstream"),
                                    "show", f"{COMMIT}:{path}"])
    with tarfile.open(directory / "node-v22.23.1.tar.xz", mode="r|xz") as archive:
        source_files = {}
        for member in archive:
            name = member.name.removeprefix(f"node-v{VERSION}/")
            if name in ("src/node_version.h", "LICENSE", "README.md") and member.isfile():
                stream = archive.extractfile(member)
                source_files[name] = stream.read()
    if (source_files["src/node_version.h"] != inputs["node-version.h"]
            or source_files["LICENSE"] != inputs["node-LICENSE"]):
        raise ValueError("PCRE Git source and release source differ")
    fingerprint = b"890C08DB8579162FEE0DF9DB8BEAB4DFCF555EF4"
    if fingerprint not in source_files["README.md"]:
        raise ValueError("PCRE signer is not named by the release source")
    with tarfile.open(directory / "node-v22.23.1-linux-x64.tar.xz", mode="r|xz") as archive:
        upstream = []
        for member in archive:
            name = member.name.removeprefix(f"node-v{VERSION}-linux-x64/")
            if name in ("bin/node", "LICENSE") and member.isfile():
                stream = archive.extractfile(member)
                digest = hashlib.file_digest(stream, "sha256")
                upstream.append(("usr/local/" + name, digest.hexdigest()))
    check_shipped(upstream)
    return inputs


def check_shipped(copies):
    expected = [("usr/local/bin/node", BINARY), ("usr/local/LICENSE", node.NODE_NOTICE)]
    if Counter(copies) != Counter(expected):
        raise ValueError("PCRE requires the exact Node binary and notice across every layer")


def check_candidate(record, directory):
    candidate.check_evidence(record, directory)
    copies = []
    with tarfile.open(directory / "candidate.tar") as archive:
        manifest = json.load(archive.extractfile("manifest.json"))[0]
        for layer_path in manifest["Layers"]:
            with tarfile.open(fileobj=archive.extractfile(layer_path), mode="r|*") as layer:
                for member in layer:
                    name = member.name.lstrip("/")
                    if name in ("usr/local/bin/node", "usr/local/LICENSE") and member.isfile():
                        stream = layer.extractfile(member)
                        digest = hashlib.file_digest(stream, "sha256")
                        copies.append((name, digest.hexdigest()))
    check_shipped(copies)
    # Bind the inherited Node version and base digest to the archived build recipe.
    with tarfile.open(directory / "source.tar") as archive:
        stream = archive.extractfile("infra/package/Dockerfile")
        recipe = stream.read()
    base = (b"node:22.23.1-bookworm-slim@sha256:"
            b"6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3")
    if recipe.count(b"FROM " + base) != 2:
        raise ValueError("PCRE candidate uses different Node build inputs")


if __name__ == "__main__":
    try:
        if len(sys.argv) != 3:
            raise ValueError("Pass candidate and upstream evidence directories")
        directory = Path(sys.argv[1]).resolve()
        upstream = Path(sys.argv[2]).resolve()
        review = candidate.checker.read_json(RECORD)
        inputs = check_upstream(upstream)
        check_review(review, inputs)
        check_candidate(candidate.checker.read_json(candidate.RECORD), directory)
        print("PASS V8 PCRE test suite: exact source terms and all-layer Node bytes checked")
        print("PARTIAL image review; nine other references, bundles and source-bound R3 remain")
    except (KeyError, ValueError, OSError, TypeError, IndexError, AttributeError,
            candidate.lzma.LZMAError, tarfile.TarError):
        # Withhold source text, local paths and dependency output on refusal.
        print("FAIL PCRE source-bound evidence is missing, changed or unsupported", file=sys.stderr)
        sys.exit(1)
