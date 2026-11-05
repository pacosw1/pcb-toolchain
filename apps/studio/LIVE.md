# Live boards

PCB Studio can observe board snapshots, CLI run events, public agent updates and router previews across machines. The
coordinator is the existing job daemon; the observer and guarded launcher are TypeScript, and the iotroute preview is
written by the Rust router. The existing toolchain's legacy executables are unchanged.

## Configuration

On each participating machine, create `~/.config/pcb-live/config.json` (mode 600):

```json
{
  "url": "http://100.93.34.43:8793",
  "tokenFile": "~/.config/pcb-live/token",
  "cliPath": "~/.local/bin/pcb",
  "projects": { "/absolute/path/to/iot-lab/.git": "iot-lab" }
}
```

The `projects` key is the **real Git common directory**; all worktrees in that repository use the same project ID.
Alternatively, a project root may contain `.pcb-live.json` with `{ "projectId": "iot-lab" }`. A conflicting marker
and registration is an error. The token is the existing daemon bearer token, kept in a separate owner-readable file.
HTTP is accepted only for loopback or a Tailscale IPv4 address; HTTPS may use another origin. Do not publish the token.
The TypeScript setup helper creates or extends this file without changing an existing project's coordinator:

```sh
node --no-warnings --experimental-strip-types tools/pcb-live-setup.mts \
  --project /path/to/iot-lab --project-id iot-lab --url http://100.93.34.43:8793 \
  --token-file ~/.config/pcb-live/token
```

The guarded `pcb` launcher preserves each project's existing pinned release, or its project-local CLI when it has no
lock, while keeping the coordinator guard around the command. Older releases can report their existing saved board
and log updates; live router frames require a release with the Rust preview producer. Studio uses the configured
`cliPath` for its own operations. A separate observer can watch all existing Git worktrees using `--discover-worktrees`:

```sh
node --no-warnings --experimental-strip-types tools/pcb-live-worker.mts \
  --project /path/to/iot-lab --project-id iot-lab --url http://100.93.34.43:8793 \
  --token-file ~/.config/pcb-live/token --state-file ~/.local/state/pcb-live/iot-lab.json \
  --discover-worktrees
```

A previously downloaded release can be installed against a project lock without contacting GitHub:
`sh scripts/install.sh --lock /path/to/toolchain.lock /path/to/pcb-toolchain-VERSION.tar.gz`. The installer verifies
the archive against the lock before changing the `pcb` symlink.

On macOS `apps/studio/deploy/install-live-worker.ts` installs a per-project LaunchAgent; pass the same options plus
`--worker /absolute/path/to/pcb-live-worker.mts`. A Linux user-service template and environment example are in the
same directory. The worker is observational and its cache and journals can be replayed after disconnects.

## What is protected

The guarded CLI serializes participating build, edit, route, repair, release and adoption operations by the
project-relative KiCad board path, so gate aliases for the same file share a lock. It pins the coordinator lease
through confirmed process cleanup, including detached runs. Adoption compares the local board against the last
coordinator revision, runs the existing verified adoption, and records the resulting hash before unpinning. Different
checkouts are not automatically overwritten; reconcile them if the source hash differs. A crash with uncertain
cleanup leaves the pin in place. A restarted observer retries recovery only when confirmed cleanup or sealed adoption
evidence proves it is safe.

Direct KiCad edits, older toolchains, and scripts that bypass the guarded launcher cannot be locked by this mechanism.
Studio labels an observed writer without a guard as unprotected. Do not run a second independent coordinator for the
same project: one durable coordinator is the authority. Preserve its SQLite databases and blob store during upgrades.
When an observer reports an active unguarded writer and can identify its board, the coordinator also makes new guarded
runs wait. Observation is best effort: an undetected writer or one that starts after a guard acquires the lease can
still bypass it, so this is not universal filesystem enforcement.

## Live information

Saved boards and candidates are labeled separately. The activity panel shows reported stages, latest output, time
limit, status and explicit public agent messages/decisions; it does not expose private reasoning. Router previews are
unverified intermediate copper and are rendered only against the matching source-board hash. During a placement
pipeline, Studio observes actual intermediate candidate board files and animates footprint movement between those
snapshots. The legacy optimizer does not expose its in-memory pose at each epoch: between saved candidates, its
progress is shown in the log. Placement providers can also emit `iot-lab.placement-preview.v1` frames directly.
Neither preview is a DRC, gate, fabrication, or adoption verdict.

The machine sidebar groups known boards by reporting host and marks active, waiting and stale observations. Following
a board is view-only. Recorded routing and candidate frames can be replayed; when the existing placement search
finishes, the worker also reads its saved epoch poses for replay. Epoch poses are not available live during that
search. The coordinator retains replay blobs for its configured `JOBD_BLOB_KEEP_DAYS` window (30 days by default);
older frames are reported as expired. Replay is capped at the first 2,000 available frames per run.

The 3D snapshot button asks the reporting machine to export the selected board snapshot with its local KiCad models.
The model is a fixed snapshot; select it again for a newer board. Routing and placement overlays remain in the 2D view.
KiCad and the referenced model files must be available on the reporting machine, and Studio reports missing-model
warnings or export errors. A snapshot exported from a project-external scratch path may be unavailable for 3D.
