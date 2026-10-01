#!/usr/bin/env bash
# Downloads the two real release binaries this spike needs -- agentgateway
# and OpenFGA -- into .tools/ (gitignored), and checks each one against a
# SHA-256 checksum pinned right here in this script (so it is checked into
# the repo, unlike .tools/ itself). This is what makes ./scripts/run.sh
# work from a clean clone: before this script existed, .tools/ only ever
# existed on whichever machine downloaded it by hand.
#
# Plain-English summary of what it does, in order:
#   1. work out which of the two supported platforms we are on
#      (darwin-arm64 or linux-amd64; anything else is refused, loudly);
#   2. download agentgateway's single binary and OpenFGA's tarball for
#      that platform, unless a correctly-checksummed copy is already
#      sitting in .tools/ from a previous run;
#   3. verify each download's SHA-256 against the value pinned below --
#      if it does not match, the download is deleted and the script fails,
#      it is never used anyway;
#   4. extract the OpenFGA tarball and make both binaries executable.
#
# Every checksum below was read from the release's own checksum file
# (OpenFGA ships one checksums.txt covering every platform; agentgateway
# ships one <asset>.sha256 file per asset), not computed from a download
# and then trusted blindly.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

AGENTGATEWAY_VERSION="v1.5.0"
OPENFGA_VERSION="1.21.0"
TOOLS_DIR=".tools"

# --- pinned checksums (see the comment above: from each release's own
#     checksum file, not re-derived here) ---------------------------------
AGENTGATEWAY_SHA256_DARWIN_ARM64="da432d35bd696da0564f7b2b6bbc783542b6b9c616d6c0c4d4c3daef9dfa11a1"
AGENTGATEWAY_SHA256_LINUX_AMD64="daca5cda76e8c5ab0c1a75912fecf2d6365095403f810db72029c49d14a37e7b"
OPENFGA_SHA256_DARWIN_ARM64="cb8adb607357c735c97412fe6a9c6bd30e10a0ab3838ef00f802f55276fb9baa"
OPENFGA_SHA256_LINUX_AMD64="0230a0f72c7bcc8ae6aeddd9dbf6d519e52934ab714b2900ce164d165b6df389"

# --- work out the platform ------------------------------------------------
os="$(uname -s)"
arch="$(uname -m)"
case "${os}-${arch}" in
  Darwin-arm64)
    platform="darwin-arm64"
    agentgateway_sha256="${AGENTGATEWAY_SHA256_DARWIN_ARM64}"
    openfga_sha256="${OPENFGA_SHA256_DARWIN_ARM64}"
    openfga_asset="openfga_${OPENFGA_VERSION}_darwin_arm64.tar.gz"
    ;;
  Linux-x86_64)
    platform="linux-amd64"
    agentgateway_sha256="${AGENTGATEWAY_SHA256_LINUX_AMD64}"
    openfga_sha256="${OPENFGA_SHA256_LINUX_AMD64}"
    openfga_asset="openfga_${OPENFGA_VERSION}_linux_amd64.tar.gz"
    ;;
  *)
    echo "fetch-tools.sh: unsupported platform '${os}-${arch}'." >&2
    echo "This spike only pins checksums for darwin-arm64 and linux-amd64." >&2
    echo "Add a pinned SHA-256 for your platform above if you need another one." >&2
    exit 1
    ;;
esac
echo "== platform: ${platform} =="

mkdir -p "${TOOLS_DIR}"

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}

# Downloads $2 (a URL) to $1 (a path) only if $1 isn't already there with
# the expected checksum $3. Fails loudly, and removes the bad file, if the
# checksum doesn't match what's pinned above -- a corrupted or tampered
# download is never left in place for a later step to pick up by accident.
fetch_and_verify() {
  local dest="$1" url="$2" expected_sha256="$3" label="$4"
  if [ -f "${dest}" ] && [ "$(sha256_of "${dest}")" = "${expected_sha256}" ]; then
    echo "== ${label}: already present with the correct checksum, skipping download =="
    return 0
  fi
  echo "== downloading ${label} =="
  echo "   ${url}"
  rm -f "${dest}"
  curl -sL --fail -o "${dest}" "${url}"
  local actual_sha256
  actual_sha256="$(sha256_of "${dest}")"
  local size_bytes
  size_bytes="$(wc -c < "${dest}" | tr -d ' ')"
  if [ "${actual_sha256}" != "${expected_sha256}" ]; then
    rm -f "${dest}"
    echo "fetch-tools.sh: SHA-256 mismatch for ${label}." >&2
    echo "  expected: ${expected_sha256}" >&2
    echo "  actual:   ${actual_sha256}" >&2
    echo "  Refusing to use this download." >&2
    exit 1
  fi
  echo "== ${label}: ${size_bytes} bytes, SHA-256 ${actual_sha256} (matches the pinned value) =="
}

# --- agentgateway (single binary, Apache-2.0) -----------------------------
agentgateway_bin="${TOOLS_DIR}/agentgateway-${platform}"
agentgateway_url="https://github.com/agentgateway/agentgateway/releases/download/${AGENTGATEWAY_VERSION}/agentgateway-${platform}"
fetch_and_verify "${agentgateway_bin}" "${agentgateway_url}" "${agentgateway_sha256}" "agentgateway ${AGENTGATEWAY_VERSION} (${platform})"
chmod +x "${agentgateway_bin}"

# --- OpenFGA (tarball containing the binary, Apache-2.0) ------------------
openfga_tarball="${TOOLS_DIR}/${openfga_asset}"
openfga_url="https://github.com/openfga/openfga/releases/download/v${OPENFGA_VERSION}/${openfga_asset}"
fetch_and_verify "${openfga_tarball}" "${openfga_url}" "${openfga_sha256}" "OpenFGA v${OPENFGA_VERSION} (${platform})"

openfga_dir="${TOOLS_DIR}/openfga_${OPENFGA_VERSION}"
if [ ! -x "${openfga_dir}/openfga" ]; then
  echo "== extracting OpenFGA =="
  mkdir -p "${openfga_dir}"
  tar -xzf "${openfga_tarball}" -C "${openfga_dir}"
  chmod +x "${openfga_dir}/openfga"
fi

echo "== fetch-tools.sh done: agentgateway at ${agentgateway_bin}, OpenFGA at ${openfga_dir}/openfga =="
