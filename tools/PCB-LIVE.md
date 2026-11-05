# Recorded solver observation

Studio's **Live solver** tab follows actual native search activity. It is read-only: pausing, seeking, comparing and selecting do not control a solver or adopt a candidate.

## Start an observed run

Run from a full toolchain checkout. Use Node 22.13 or newer, the matching instrumented native binaries, and a coordinator running `apps/job-daemon` from this revision. Set `JOBD_URL` and `JOBD_TOKEN_FILE` in both the worker and Studio engine environments. Keep the token file private; the renderer never receives it.

```sh
node --experimental-strip-types --no-warnings tools/pcb-live-run.mts \
  --board /scratch/ENV-SENSE.kicad_pcb --model /scratch/problem.json \
  --operation placement --project ENV-SENSE --spool /scratch/place-observation \
  -- iotplace run /scratch/problem.json -o /scratch/placement.json \
  --workers 2 --epochs 20 --steps 20000

node --experimental-strip-types --no-warnings tools/pcb-live-run.mts \
  --board /scratch/placed/ENV-SENSE.kicad_pcb --model /scratch/route-model.json \
  --operation routing --project ENV-SENSE --spool /scratch/route-observation \
  -- iotroute /scratch/route-model.json /scratch/route-result.json --iters 40
```

The board must be the source of the supplied model. Use a new spool directory for each invocation. Run the wrapper on the solver host; native observations are local files and only the wrapper contacts the coordinator. This opt-in entry point does not change existing route or placement dispatch defaults. When wrapping Docker, explicitly forward the observation environment and mount its paths identically inside the container.

The wrapper sets `PCB_LIVE_EVENTS`; placement also receives the existing `IOTPLACE_LIVE_*` board/model/attempt bindings. Observation failures never change move acceptance or router rules. Observation has overhead, so wall-clock-limited searches can reach their time boundary earlier; deterministic equality applies with equal completed work, not equal elapsed time.

## Recording and recovery

Native producers append local NDJSON. The wrapper converts group poses into per-footprint KiCad coordinates and records protocol events and the source cursor atomically in a SQLite WAL spool. The immutable base board is uploaded before the event stream. Sequence numbers make delivery retries idempotent.

```sh
node --experimental-strip-types --no-warnings tools/pcb-live-run.mts \
  --spool /scratch/route-observation --resume
```

Resume uploads recorded events and does not restart the solver. If the original observer did not record the solver exit, recovery reports an unknown outcome rather than inferring success. Preserve the spool until delivery is acknowledged. Native logs are bounded to 512 MiB; an observation limit does not constitute a solver failure or a verified board.

The coordinator persists events and replay checkpoints in `live.sqlite`, and stores immutable source boards separately from the job blob cache. Its authenticated API includes `/live/runs`, `/live/events`, `/live/assets/:sha`, and `/live/runs/:id/{events,state,stream}`. SSE supports `Last-Event-ID`; Studio relays that stream through its authenticated engine connection, batches presentation at 100 ms, and uses cursor polling for recovery after connection loss. Replay uses the same reducer as live viewing.

## Reading the view

- Placement samples contain the current worker pose, its best pose within that epoch, acceptance counts, locks and costs. The best pose is not a final legalized candidate. Weights change by epoch, so costs from different epochs are not directly comparable. Source copper is hidden while components move.
- Routing displays native copper additions/removals, active nets, sampled A* paths, rejected paths and exact audit conflicts. Copper includes fixed items from the model; original source tracks are not drawn a second time. Removed tracks appear as dashed ghosts.
- Failure buttons focus their recorded region. Exact audit conflicts identify actual conflicting shapes. Search failures explicitly label nearby copper as context when a causal blocker was not isolated.
- Pause freezes the view while ingestion continues. Scrub or choose a checkpoint, compare against the current view, then return to live. Schematic anchors, board selection and BOM rows share component/net selection.
- The canvas transforms cached pad geometry directly and draws copper without generating GLB files. Native search samples target 100 ms; the UI batches received events and presents interpolation on animation frames.

A solver's `PASS`, `FAIL`, `STUCK` or `YIELDED` result remains visible. A native pass is never independent verification, adoption or fabrication approval.

## Verification, 2026-11-05

An isolated Linux coordinator and native worker observed copied ENV-SENSE inputs; Studio connected from macOS through an SSH tunnel. No production deployment or canonical-board edits were made.

- Placement: 12 epochs, 50,000 steps, two workers; 107 recorded events and two legal candidates. A longer 24-epoch run produced 685 events for pause/replay checks.
- Routing of the placed copy: six passes at 0.05 mm pitch, 3,154 events; final 158 tracks and 21 vias. Native result was **FAIL**, two unresolved nets. This verifies observation of a failed run, not successful routing.
- With observation disabled, the same actual ENV-SENSE placement histories/candidates and complete routing JSON were identical.
- A real cross-machine streaming run measured 6.3 visible geometry updates/s and 60 presentation frames/s over three seconds. A paused view stayed at event 94 while recording advanced to 124.
- Browser checks covered pause while head advances, exact checkpoint seek, comparison, best/current pose, return to live, U1 across BOM/schematic, failure zoom and page reload/reconnect. No browser errors were observed.
- Automated tests cover native on/off equality, group rotation, lost HTTP acknowledgment, spool re-upload, protocol validation, atomic deltas, journal restart/seek and HTTP reconnect/replay.
