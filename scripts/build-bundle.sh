#!/bin/sh
# Build a pcb-toolchain release bundle: dist/pcb-toolchain-VERSION.tar.gz + SHA256SUMS. Never publishes.
#   scripts/build-bundle.sh VERSION [--linux]
# --linux also builds iotroute for linux-x86_64 on BUILD_LINUX_HOST (user@host with Docker; rust image).
set -eu
here=$(cd "$(dirname "$0")/.." && pwd -P)
version=${1:?usage: build-bundle.sh VERSION [--linux]}
linux=${2:-}
sha=$(git -C "$here" rev-parse HEAD)
[ -z "$(git -C "$here" status --porcelain)" ] || { echo 'FAIL: working tree not clean' >&2; exit 2; }
name="pcb-toolchain-$version"
stage=$(mktemp -d)
out="$stage/$name"
mkdir -p "$out/bin" "$here/dist"
echo "START: copy tool tree"
(cd "$here" && git archive --format=tar HEAD tools bin) | tar -x -C "$out"
echo "$version $sha" > "$out/VERSION"
echo "START: iotroute darwin-arm64"
(cd "$here/tools/router/core" && RUSTFLAGS="--remap-path-prefix=$HOME=~ --remap-path-prefix=$here=." cargo build --release --quiet)   # no build-machine paths in the binary
cp "$here/tools/router/core/target/release/iotroute" "$out/bin/iotroute-darwin-arm64"
if [ "$linux" = --linux ]; then
  linux_host=${BUILD_LINUX_HOST:?set BUILD_LINUX_HOST=user@host (Docker) for --linux}
  echo "START: iotroute linux-x86_64 ($linux_host)"
  ssh "$linux_host" 'rm -rf /tmp/iotroute-src && mkdir -p /tmp/iotroute-src'
  (cd "$here/tools/router/core" && git archive --format=tar HEAD .) | ssh "$linux_host" 'tar -x -C /tmp/iotroute-src'
  ssh "$linux_host" 'docker run --rm -v /tmp/iotroute-src:/src -w /src rust:1 cargo build --release --quiet'
  scp -q "$linux_host":/tmp/iotroute-src/target/release/iotroute "$out/bin/iotroute-linux-x86_64"
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
