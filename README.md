# pcb-toolchain

The PCB toolchain of the iot-lab hardware repo, as a versioned, installed release: the `pcb` CLI (`tools/pcb`), the
in-house router `iotroute` (Rust core + model/write), the placer, the board gate (`gate.mjs` + checks), doctor and the
JLC part tools. Board data and board build scripts stay in iot-lab. CIP epic 87 (user decision 2026-11-04).

Status: scaffold. The tool sources are imported with their history from iot-lab after the untangle step (CIP 1289)
merges (`manifest/shared-paths.txt`, `git filter-repo --paths-from-file`).

## Why a bundle, not a wheel

`tools/pcb` is a stdlib launcher. Its backends run under four runtimes: system `python3`, KiCad's bundled Python 3.9
(pcbnew; scripts import their neighbours by file path), `node` (the gate) and the Rust `iotroute` binary. A Python
wheel or a uv environment cannot serve the KiCad-Python children. So a release is an immutable directory tree:

```
pcb-toolchain-<version>/
  VERSION                 version + source git sha
  manifest.json           every file with its sha256 (run records cite it)
  tools/...               the shared tool tree, layout unchanged
  bin/iotroute-<target>   prebuilt router (darwin-arm64, linux-x86_64)
  bin/pcb                 launcher
```

## Use from a project

The project (iot-lab) pins one release in `toolchain.lock`:

```json
{"schema": "iot-lab.toolchain-lock.v1", "version": "0.1.0", "sha256": "<tarball sha256>",
 "source": "github:pacosw1/pcb-toolchain"}
```

`scripts/install.sh` installs the pinned release to `~/.local/share/pcb-toolchain/<version>/` and links
`~/.local/bin/pcb`. `bin/pcb` finds the project root (`--project DIR`, else `IOT_LAB`, else the nearest parent of the
working directory that holds `hardware-design/boards/`), checks that the installed version equals the project lock,
exports `IOT_LAB` and `PCB_TOOLCHAIN_ROOT`, and runs the bundled `tools/pcb`.

## Release

`scripts/build-bundle.sh VERSION` (on the Mac) builds `dist/pcb-toolchain-VERSION.tar.gz` + `SHA256SUMS`:
it copies the tool tree, builds `iotroute` for darwin-arm64 with cargo and for linux-x86_64 on the Hetzner box
(`--linux`), writes `VERSION` and `manifest.json`. `gh release create vVERSION dist/*` publishes it (private repo).
