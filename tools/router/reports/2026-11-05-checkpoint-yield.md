# Continuation-only checkpoint stops (#1316)

Final base: `d32a6d2` plus the yield implementation. The prior audit found that a
two-pass checkpoint run still did strict and length recovery before exiting.
Resume then discarded that finalized candidate and restarted from the earlier
pass boundary. This work removes that unnecessary finalization when a caller
explicitly requests a continuation.

## Behavior

`iotroute MODEL OUT --iters 80 --resume-save STATE --yield-after-passes 2`
stops after two completed passes in this invocation if work remains. It saves
the next-pass state, writes a durable `iot-lab.route-yield.v1` receipt to OUT,
and exits 3. The receipt has no copper, says `finalized: false`, and binds the
state file by SHA-256. Optional progress changes to `state: yielded`.

Resume with the same binary/model/routing flags. The yield limit can change or
be omitted. Omitting it finalizes normally; convergence and terminal unchanged
hard failures also retain normal finalization. Ordinary invocations are unchanged.
To finalize exactly the paused state without another negotiation pass, omit the
yield flag and set the total `--iters` limit equal to the saved pass count.
Argument/path validation prevents missing state destinations, zero budgets and
aliases; a persistence error exits 2 rather than publishing a usable continuation.

This is a core supervisor interface. `iotroute run` and `pcb route` do not yet
accept it. A future portfolio supervisor must interpret exit 3 explicitly, keep
state files isolated, validate receipts, own the total CPU/wall budget, and run
normal native checks on finalized candidates. Do not pass a yield receipt to the
board writer or treat it as verified output. Per-pass boundaries are cooperative;
this flag does not interrupt an A* expansion or enforce a hard wall deadline.

## Validation

- Full macOS Rust suite after rebase onto `d32a6d2`: 904 passed, two ignored.
- Six focused CLI tests passed on macOS and Linux: repeated yields and replay;
  convergence at the yield boundary; invalid budgets/path aliases/unwritable
  state; iteration/time limits; SIGTERM and subsequent exact replay; finalizing
  a saved boundary without an extra search pass.
- The replay test checks `tracks`, `vias`, `failed`, and `passes`. It checks that
  a stale OUT is replaced by a non-final receipt, the checkpoint hash matches,
  and no strict/length/return finalization messages occur on the yield path.
- Existing default-route and resume tests remain passing.

## Frozen ENV-SENSE model experiment

All five child invocations used the same binary and model in one existing
`pcb-release-smoke:test` container, sequentially, with two CPUs and 8 GiB RAM.
The container had no network. Compilation was outside the timing interval.
The model came from native accepted run `run-3F6FYu` in the earlier audit.
This is a core replay/timing experiment, not a new native-board acceptance run.

| Invocation | Exit | Wall seconds |
| --- | ---: | ---: |
| Uninterrupted, 80-pass budget | 0 | 7.757 |
| Old stop after pass 2, with final recovery | 0 | 20.805 |
| Resume old checkpoint to convergence | 0 | 7.746 |
| New yield after pass 2, no final recovery | 3 | 2.370 |
| Resume yielded checkpoint to convergence | 0 | 11.225 |

Old split total: **28.551 s**. New split total: **13.595 s**. Both resumed results
equal the uninterrupted result in tracks, vias, failures and pass count; all
converged in seven passes with no failed nets. The default full result also
matches the raw core result from the earlier audit. The saved state is
4,488,067 bytes. Yield receipt accounting reports 2.336 s through persistence
and 2.362 CPU seconds; complete child wall time is the table's 2.370 s.

The host was shared and cache/load conditions were not controlled. This single
trial demonstrates removal of the expensive discarded recovery phase; it does
not establish general speedup, multicore throughput, or that splitting is faster
than an uninterrupted run. An earlier intermediate-build trial observed
51.330 s versus 12.451 s, illustrating the host-load variation; those observations
are not pooled with the final-build trial. Full-invocation accounting belongs to the supervisor;
receipt counters exclude receipt writing/process exit, and saved-boundary
counters exclude the current checkpoint write.

| Artifact | SHA-256 |
| --- | --- |
| Linux binary | 43584604ff766d1f41b8d236e9147c43a048dc9978f76365e04c55cd310e825d |
| Frozen model | 737bab78968362e4acad86bc6a0c861fd68336560c7c5e474baf05919db186b0 |
| Yielded state | ca6b54f8379a978445522952e944d44f1ca5b640c80f76574bde0c63c75218d6 |

The standalone benchmark harness, raw outputs/logs, state and tested binary are
retained in the task's evidence archive. No canonical CAD, production runtime,
gate, rule, or adoption policy changed.
