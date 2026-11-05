# pcb-toolchain

A KiCad 10 PCB toolchain as a versioned, installed release: the `pcb` CLI (`tools/pcb`), the in-house router
`iotroute` (Rust core + model/write), the placer, the board gate (`gate.mjs` + checks), doctor and the JLC part
tools. Board data and board build scripts stay in the project repo that uses it.

`apps/studio/` is PCB Studio, the desktop app (see its README). It is not part of the release bundle.

License: GPL-3.0 (see `LICENSE`). Parts are derived from GPL-3.0 sources (`tools/backend-patches/`,
`tools/FreeroutingLive.java`).

## Why a bundle, not a wheel

`tools/pcb` is a shell dispatcher into Node/TypeScript orchestration. Routing, placement and native board reads use
Rust executables and KiCad workers. Some legacy scripts and pinned upstream checks still need Python on the worker.
The release includes these runtimes' shared files as an immutable directory tree:

```
pcb-toolchain-<version>/
  VERSION                 version + source git sha
  manifest.json           every file with its sha256 (run records cite it)
  tools/...               the shared tool tree, layout unchanged
  bin/iotroute-<target>   prebuilt router (darwin-arm64, linux-x86_64)
  bin/pcb                 launcher
```

## Requirements

- KiCad 10 (`kicad-cli`), Node 22.6 or newer, and the release's prebuilt Rust executables.
- Python remains a worker dependency for the remaining legacy scripts and pinned upstream checks; the `pcb` launcher uses Node.
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
| `JOBD_URL` | job daemon (`apps/job-daemon`) for `tools/remote.sh`, used when it answers, else SSH; and for `pcb route --router iotroute`, else local (`tools/router/route-dispatch.mjs`) |
| `PCB_LIVE_BIND` | address for the live route viewer (default `127.0.0.1`) |
| `PCB_LIVE_HOST` | host name the viewer prints in its URL (default `localhost`) |

## Release

`scripts/build-bundle.sh VERSION [--linux]` builds `dist/pcb-toolchain-VERSION.tar.gz` + `SHA256SUMS`: it copies the
tool tree, builds `iotroute` and `iotplace` for darwin-arm64, and writes `VERSION` and `manifest.json`. With `--linux`,
it also builds those tools and `route-coverage` for linux-x86_64 on `BUILD_LINUX_HOST` using the bookworm Rust image.
The Linux `route-coverage` artifact is available for explicit testing; daemon staging and native thermal receipt parity
remain to be verified.

Publish only this version's tarball, with a one-line `SHA256SUMS` (the asset name `install.sh` reads). Run from the
repo root, with VERSION replaced:

```sh
(cd dist && shasum -a 256 pcb-toolchain-VERSION.tar.gz > SHA256SUMS)
gh release create vVERSION --target "$(git rev-parse HEAD)" dist/pcb-toolchain-VERSION.tar.gz dist/SHA256SUMS
```

`--target` must be the commit the bundle was built from (its `VERSION` file). Use the same HEAD as the build.
