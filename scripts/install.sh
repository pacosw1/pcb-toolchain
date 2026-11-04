#!/bin/sh
# Install a pcb-toolchain release and link ~/.local/bin/pcb.
#   scripts/install.sh VERSION [TARBALL]      (no TARBALL: gh release download vVERSION)
#   scripts/install.sh --lock PROJECT/toolchain.lock
# The tarball sha256 must equal the lock (with --lock) or SHA256SUMS of the release.
set -eu
if [ "${1:-}" = --lock ]; then
  lock=${2:?usage: install.sh --lock FILE}
  version=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1])).version' "$lock")
  want=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1])).sha256' "$lock")
  tarball=''
else
  version=${1:?usage: install.sh VERSION [TARBALL]}
  tarball=${2:-}
  want=''
fi
dest="$HOME/.local/share/pcb-toolchain/$version"
rec="$HOME/.local/share/pcb-toolchain/$version.sha256"   # tarball sha256 recorded at install time
if [ -x "$dest/bin/pcb" ]; then
  if [ -n "$want" ]; then
    have=$(cat "$rec" 2>/dev/null || true)
    if [ -z "$have" ]; then echo "FAIL: cannot verify $dest against the lock: no recorded sha256 (remove $dest and reinstall)" >&2; exit 1; fi
    if [ "$have" != "$want" ]; then echo "FAIL: installed sha256 $have != lock $want (remove $dest and reinstall)" >&2; exit 1; fi
  fi
  echo "PASS: pcb-toolchain $version already installed"; ln -sf "$dest/bin/pcb" "$HOME/.local/bin/pcb"; exit 0
fi
tmp=$(mktemp -d)
if [ -z "$tarball" ]; then
  gh release download "v$version" --repo pacosw1/pcb-toolchain --dir "$tmp" --pattern "pcb-toolchain-$version.tar.gz" --pattern SHA256SUMS
  tarball="$tmp/pcb-toolchain-$version.tar.gz"
  [ -n "$want" ] || want=$(grep " pcb-toolchain-$version.tar.gz\$" "$tmp/SHA256SUMS" | cut -d' ' -f1)
fi
got=$(shasum -a 256 "$tarball" | cut -d' ' -f1)
if [ -n "$want" ] && [ "$got" != "$want" ]; then echo "FAIL: sha256 $got != $want" >&2; exit 1; fi
mkdir -p "$HOME/.local/share/pcb-toolchain" "$HOME/.local/bin"
tar -xzf "$tarball" -C "$tmp"
mv "$tmp/pcb-toolchain-$version" "$dest"
echo "$got" > "$rec"
chmod -R a-w "$dest"                          # immutable install: agents run the release, never edit it
ln -sf "$dest/bin/pcb" "$HOME/.local/bin/pcb"
rm -rf "$tmp"
echo "PASS: pcb-toolchain $version -> $dest (sha256 $got)"
