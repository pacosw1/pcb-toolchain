#!/bin/sh
# Build a pcb-toolchain release bundle: dist/pcb-toolchain-VERSION.tar.gz + SHA256SUMS. Never publishes.
#   scripts/build-bundle.sh VERSION [--linux]
# --linux also builds iotroute for linux-x86_64 on BUILD_LINUX_HOST (user@host with Docker; rust image).
set -eu
here=$(cd "$(dirname "$0")/.." && pwd -P)
version=${1:?usage: build-bundle.sh VERSION [--linux]}
linux=${2:-}
if [ $# -gt 2 ]; then echo 'usage: build-bundle.sh VERSION [--linux]' >&2; exit 2; fi
case "$linux" in ''|--linux) ;; *) echo 'usage: build-bundle.sh VERSION [--linux]' >&2; exit 2 ;; esac
sha=$(git -C "$here" rev-parse HEAD)
[ -z "$(git -C "$here" status --porcelain)" ] || { echo 'FAIL: working tree not clean' >&2; exit 2; }
name="pcb-toolchain-$version"
stage=$(mktemp -d)
out="$stage/$name"
mkdir -p "$out/bin" "$here/dist"
echo "START: copy tool tree"
(cd "$here" && git archive --format=tar HEAD tools bin) | tar -x -C "$out"
echo "$version $sha" > "$out/VERSION"
mkdir -p "$out/tools/pcb-job"                                          # tools/remote.sh submits to the job daemon with this client
(cd "$here" && git archive --format=tar HEAD apps/job-daemon/src/client.ts apps/job-daemon/src/types.ts) | tar -x -C "$out/tools/pcb-job" --strip-components=3
echo "START: iotroute darwin-arm64"
(cd "$here/tools/router/core" && RUSTFLAGS="--remap-path-prefix=$HOME=~ --remap-path-prefix=$here=." cargo build --release --locked --quiet)   # no build-machine paths in the binary
cp "$here/tools/router/core/target/release/iotroute" "$out/bin/iotroute-darwin-arm64"
if [ "$linux" = --linux ]; then
  linux_host=${BUILD_LINUX_HOST:?set BUILD_LINUX_HOST=user@host (Docker) for --linux}
  echo "START: iotroute linux-x86_64 ($linux_host)"
  rsrc=$(ssh "$linux_host" 'mktemp -d /tmp/iotroute-src.XXXXXX')
  # root-owned build output (target/) may block a plain rm; then clean up inside the rust image as root
  clean_linux() { ssh "$linux_host" "rm -rf '$rsrc' 2>/dev/null || { docker run --rm -v '$rsrc:/src' rust:1.93.1 sh -c 'rm -rf /src/* /src/.[!.]*'; rm -rf '$rsrc'; }" || echo "WARN: could not remove $rsrc on $linux_host" >&2; }
  trap clean_linux EXIT
  (cd "$here/tools/router/core" && git archive --format=tar HEAD .) | ssh "$linux_host" "tar -x -C '$rsrc'"
  ssh "$linux_host" "docker run --rm -e RUSTFLAGS='--remap-path-prefix=/src=.' -v '$rsrc:/src' -w /src rust:1.93.1 cargo build --release --locked --quiet"
  scp -q "$linux_host:$rsrc/target/release/iotroute" "$out/bin/iotroute-linux-x86_64"
  clean_linux
  trap - EXIT
fi
echo "START: manifest"
python3 - "$out" "$version" "$sha" <<'EOF'
import hashlib, json, os, sys
root, version, sha = sys.argv[1:]
files = {}
for d, _, fs in os.walk(root):
    for f in sorted(fs):
        p = os.path.join(d, f)
        files[os.path.relpath(p, root)] = hashlib.sha256(open(p, 'rb').read()).hexdigest()
json.dump({'schema': 'pcb-toolchain.manifest.v1', 'version': version, 'source_sha': sha, 'files': files},
          open(os.path.join(root, 'manifest.json'), 'w'), indent=1, sort_keys=True)
print(len(files), 'files')
EOF
COPYFILE_DISABLE=1 tar --no-xattrs -C "$stage" -czf "$here/dist/$name.tar.gz" "$name"   # macOS tar otherwise adds ._* files, visible only on Linux
got=$(gzip -dc "$here/dist/$name.tar.gz" | LC_ALL=C grep -a -c "/\._" || true)
[ "$got" = 0 ] || { echo "FAIL: $got ._ entries in the bundle" >&2; exit 1; }
(cd "$here/dist" && { grep -v "  $name.tar.gz\$" SHA256SUMS 2>/dev/null; shasum -a 256 "$name.tar.gz"; } > SHA256SUMS.new && mv SHA256SUMS.new SHA256SUMS && tail -1 SHA256SUMS)   # a rebuild replaces its line
rm -rf "$stage"
echo "PASS: dist/$name.tar.gz"
