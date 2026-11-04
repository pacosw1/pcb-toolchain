`pcb-routing-trial` ports `pcb_routing_trial.py` into a small Rust library. It prepares an invocation and
checks the producer's controls; full native gate acceptance remains upstream. Existing Python importers and the
unported Fastroute/thermal producers still use their original files.

The Mac calls `tools/lib/pcb-routing-admission.ts` for gate and explicitly selected quality-backend admission, using
the existing shared validators. Ship their hash bindings with the job, remapping absolute external paths through
the existing file transport. Relative source bindings resolve under `PrepareRequest.root`. Rust reopens these
bindings before recording the run. There is no Node subprocess in the daemon.

`prepare`, `validate`, `finalize`, `execution_context`, and `native_execution_context` are the library API. Request and
receipt types implement serde for the owning daemon's transport. Preparation still launches the existing
producer's `--version` probes.

The library's v2 `finalize` takes a `ThermalVerifier` supplied by the owner of the native thermal checker. Its methods
must reopen the capability and discharge native evidence, just as the original helper does. That helper's port and
the callers' integration are outside this file's scope; this library never trusts a precomputed thermal verdict.

Targeted checks:

```sh
cargo test -j 2 --manifest-path tools/pcb_routing_trial/Cargo.toml
node --test tools/lib/pcb-routing-admission.test.ts
```
