# pcb-toolchain

A KiCad 10 PCB toolchain as a versioned, installed release: the `pcb` CLI (`tools/pcb`), the in-house router
`iotroute` (Rust core + model/write), the placer, the board gate (`gate.mjs` + checks), doctor and the JLC part
tools. Board data and board build scripts stay in the project repo that uses it.

`apps/studio/` is PCB Studio, the desktop app (see its README). It is not part of the release bundle.

License: GPL-3.0 (see `LICENSE`). Parts are derived from GPL-3.0 sources (`tools/backend-patches/`,
`tools/FreeroutingLive.java`).

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

## Requirements

- KiCad 10 (`kicad-cli` and its bundled Python with `pcbnew`), `python3`, `node`.
- The gate pins some third-party repos (for example kicad-happy, KiCadRoutingTools). They must be checked out under
  `~/Documents/GitHub/` at the commits in `tools/lib/env.mjs`. `pcb doctor` reports what is missing.
- Remote jobs (`tools/remote.sh`) need `REMOTE_HOST=user@host` with Docker and the `iot-lab-route` image.

## Use from a project

The project pins one release in `toolchain.lock`:

```json
{"schema": "iot-lab.toolchain-lock.v1", "version": "0.1.0", "sha256": "<tarball sha256>",
 "source": "github:pacosw1/pcb-toolchain"}
```

`scripts/install.sh` installs the pinned release to `~/.local/share/pcb-toolchain/<version>/` and links
`~/.local/bin/pcb`. `bin/pcb` finds the project root (`--project DIR`, else `IOT_LAB`, else the nearest parent of the
working directory that holds `hardware-design/boards/`), checks that the installed version equals the project lock,
loads `.pcb-toolchain.env` from the project (KEY=VALUE lines; the caller's environment wins), exports `IOT_LAB` and
`PCB_TOOLCHAIN_ROOT`, and runs the bundled `tools/pcb`.

Project settings in `.pcb-toolchain.env`:

| Key | Use |
| --- | --- |
| `REMOTE_HOST` | `user@host` for `tools/remote.sh` jobs over SSH |
| `JOBD_URL` | job daemon for `tools/remote.sh` (`apps/job-daemon`); used when it answers, else SSH |
| `PCB_LIVE_BIND` | address for the live route viewer (default `127.0.0.1`) |
| `PCB_LIVE_HOST` | host name the viewer prints in its URL (default `localhost`) |

## Release

`scripts/build-bundle.sh VERSION [--linux]` builds `dist/pcb-toolchain-VERSION.tar.gz` + `SHA256SUMS`: it copies the
tool tree, builds `iotroute` for darwin-arm64 with cargo (and for linux-x86_64 on `BUILD_LINUX_HOST` with `--linux`),
and writes `VERSION` and `manifest.json`.

Publish only this version's tarball, with a one-line `SHA256SUMS` (the asset name `install.sh` reads). Run from the
repo root, with VERSION replaced:

```sh
(cd dist && shasum -a 256 pcb-toolchain-VERSION.tar.gz > SHA256SUMS)
gh release create vVERSION --target "$(git rev-parse HEAD)" dist/pcb-toolchain-VERSION.tar.gz dist/SHA256SUMS
```

`--target` must be the commit the bundle was built from (its `VERSION` file). Use the same HEAD as the build.
