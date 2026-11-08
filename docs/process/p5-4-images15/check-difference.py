"""Check one npm source difference against signed inputs and saved image layers."""

import contextlib
import hashlib
import importlib.util
import io
import json
import sys
import tarfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
RECORD = HERE / "difference.json"
RECORD_SHA256 = "0cad6e20c0ad9c257a5df6713714c5a8e7b3780a18fb288091b8e4cf708c6c78"
REFUSAL = "FAIL npm source difference is missing, changed or unsupported"
COPY_RULE = (b"      /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx\n"
             b"COPY --from=runtime / /\n")
REQUIRED_LINES = COPY_RULE.splitlines(keepends=True)
RESULTS = {
    "sourceOnly": "absent",
    "officialLaunchers": "present",
    "candidateSourceOnly": "absent",
    "candidateLaunchers": "absent",
    "candidateNpmTree": "BLOCKED",
}

try:
    previous = HERE.parent / "p5-4-images14/check-npm.py"
    specification = importlib.util.spec_from_file_location("npm_inventory", previous)
    npm = importlib.util.module_from_spec(specification)
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        specification.loader.exec_module(npm)
except BaseException:
    print(REFUSAL, file=sys.stderr)
    sys.exit(1)


def digest_rows(rows):
    data = json.dumps(rows, separators=(",", ":"), ensure_ascii=True).encode()
    return hashlib.sha256(data).hexdigest()


def read_record():
    data = npm.checked_bytes(RECORD, RECORD_SHA256)
    return json.loads(data)


def difference_rows(source, official):
    source_rows = [tuple(row) for row in source]
    official_rows = [tuple(row) for row in official]
    if len(set(source_rows)) != len(source_rows):
        raise ValueError("Duplicate source entry")
    if len(set(official_rows)) != len(official_rows):
        raise ValueError("Duplicate official entry")
    source_only = sorted(set(source_rows) - set(official_rows))
    official_only = sorted(set(official_rows) - set(source_rows))
    return [list(row) for row in source_only], [list(row) for row in official_only]


def check_rows(rows, count, digest):
    if len(rows) != count or digest_rows(rows) != digest:
        raise ValueError("npm difference changed")


def check_difference(inventory, recipe, layers, record):
    expected_fields = {"status", "candidateSha256", "inventorySha256", "sourceOnlySha256",
                       "officialOnlySha256", "missingFromCandidateSha256", "results"}
    if set(record) != expected_fields or record["status"] != "BLOCKED":
        raise ValueError("npm difference cannot approve the image")
    if record["results"] != RESULTS:
        raise ValueError("npm difference results changed")
    if record["candidateSha256"] != npm.read_record()["candidateSha256"]:
        raise ValueError("Candidate binding changed")
    if record["inventorySha256"] != npm.read_record()["inventorySha256"]:
        raise ValueError("Inventory binding changed")
    for line in REQUIRED_LINES:
        if recipe.count(line) != 1:
            raise ValueError("Archived npm removal or final copy changed")
    if len(layers) != 2 or any(layer for layer in layers):
        raise ValueError("npm entry survived a candidate layer")

    source = inventory["source"]["files"]
    official = inventory["official"]["files"]
    source_only, official_only = difference_rows(source, official)
    differences = inventory["differences"]
    if source_only != differences["sourceOnly"]:
        raise ValueError("Source-only entries changed")
    if official_only != differences["officialOnly"]:
        raise ValueError("Official-only entries changed")
    if differences["changed"] != []:
        raise ValueError("Unexpected changed npm entry")
    if any(row[1] != "file" or "/test/" not in row[0] for row in source_only):
        raise ValueError("Source-only entry is not a test file")
    launcher_names = [row[0] for row in official_only]
    if launcher_names != ["bin/npm", "bin/npx"]:
        raise ValueError("Official-only entries are not the launcher links")
    if any(row[1] != "link" for row in official_only):
        raise ValueError("Official launcher type changed")
    check_rows(source_only, 184, record["sourceOnlySha256"])
    check_rows(official_only, 2, record["officialOnlySha256"])

    candidate = inventory["candidate"]
    if candidate != {"files": [], "packages": [], "notices": []}:
        raise ValueError("Candidate npm observation changed")
    missing = differences["missingFromCandidate"]
    if missing != official:
        raise ValueError("Missing candidate entries changed")
    check_rows(missing, 1966, record["missingFromCandidateSha256"])
    return dict(RESULTS)


def scan_layers(path):
    layers = []
    with tarfile.open(path) as archive:
        manifest = json.load(archive.extractfile("manifest.json"))
        if len(manifest) != 1:
            raise ValueError("Require one candidate image")
        layer_names = manifest[0]["Layers"]
        if len(layer_names) != 2 or len(set(layer_names)) != 2:
            raise ValueError("Require both candidate layers")
        for layer_name in layer_names:
            npm.safe_path(layer_name)
            stream = archive.extractfile(layer_name)
            with tarfile.open(fileobj=stream, mode="r|*") as layer:
                rows, _contents = npm.scan(layer, "usr/local/")
            layers.append(rows)
    return layers


def read_recipe(directory):
    with tarfile.open(directory / "source.tar") as archive:
        member = archive.getmember("infra/package/Dockerfile")
        if not member.isfile():
            raise ValueError("Archived Dockerfile is not a file")
        return archive.extractfile(member).read()


def check_evidence(directory, upstream):
    record = read_record()
    inventory = npm.read_inventory()
    # Authenticate the saved source before using its recorded difference.
    npm.pcre.check_upstream(upstream)
    git_archive = npm.pcre.run_checked(["git", "-C", str(upstream / "upstream"),
                                        "archive", npm.pcre.COMMIT, "deps/npm"])
    npm.check_sources(upstream, git_archive, inventory)
    candidate_record = npm.pcre.candidate.checker.read_json(npm.pcre.candidate.RECORD)
    npm.pcre.check_candidate(candidate_record, directory)
    layers = scan_layers(directory / "candidate.tar")
    recipe = read_recipe(directory)
    # Read the same saved bytes again so a swap after inspection cannot pass.
    npm.checked_bytes(directory / "candidate.tar", candidate_record["files"]["candidate.tar"])
    npm.checked_bytes(directory / "source.tar", candidate_record["files"]["source.tar"])
    return check_difference(inventory, recipe, layers, record)


def main(arguments):
    try:
        if len(arguments) != 2:
            raise ValueError("Pass candidate and upstream evidence directories")
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            results = check_evidence(Path(arguments[0]).resolve(), Path(arguments[1]).resolve())
        print("PARTIAL npm difference: 184 source tests absent from official and candidate")
        print("PASS npm launchers: two present in official, absent from candidate")
        print(f"BLOCKED candidate npm tree: {results['candidateNpmTree']}; 1,966 entries missing")
    except BaseException:
        # Withhold paths, parser errors and dependency output for every refusal.
        print(REFUSAL, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
