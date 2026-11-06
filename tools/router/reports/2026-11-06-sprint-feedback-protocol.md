# Sprint reference feedback: preregistered comparison (#1416)

Sprint finalization now uses the ordinary `Run::ref_gate` loop. Each variant
copies the immutable prepared model into its own finalization work directory,
retains its seed and via cost, and supplies its actual slice/finalize log. The
selected route must have no failed nets and pass fresh final native checks and
the unchanged configured gate. Experimental reference copper reuse stays off.
The parent deadline and owned-child cleanup still cover the entire feedback loop.

Register **one** additional Hetzner trial, `sprint-feedback-a`: frozen ESP32-CORE
rev B, two CPUs, 960 seconds, eight GiB, zero retries. This is the same 1,920
reserved CPU-second ceiling as all five #1399 comparison trials. Compare directly
with the two historical 2-CPU/960-second singles and report the historical
1-CPU/1,920-second single separately. Measure actual all-child cgroup CPU; it is
not assumed equal. There is no new calibration, baseline rerun or retry. No board
experiment runs in CI and no canonical CAD is adopted.

Keep seeds 0/1/2/3, via cost 3, parallelism 2, two-pass slices, 80 passes and the
existing 30-second verification reserve. Keep source-lock, return-exemption,
fresh native/configured checks, cleanup and timeout policy unchanged. Do not
increase reserves or budgets after observing a result. An unfinished candidate
is unqualified. Distinct seeds already produced distinct boards in #1399;
repeatability within a seed was determinism, not variant collapse.

Reuse the exact #1399 frozen hardware files (2,723 SHA-256 bindings), source
`a545d5e18428e03256ea876f45864b25061c1397`, PCB
`b6b97508157893ccca5c5c2cc3e0c90d55691a42d094f9c1015ad8b7f31bdb2b`.
Use Node 22.23.2 and runtime image
`sha256:8c1c6d83c4050f4876f21926846e4e1d640b6be5194f448c3e239392c83a20af`.
Build this implementation with Rust 1.93.1; record exact source/archive/binary
hashes before submission. Use new isolated roots and an exclusive driver-start
marker so the old trials cannot accidentally be replayed. Archive harness copies
and their differences. Do not flush shared caches; retain host load and competing
container observations.

Use the already registered #1399 benchmark qualification: native DRC, opens,
parity and every configured actual error/failure count zero, with zero active
kicad-happy findings. Count and name stale RP-001 exemptions separately without
editing or ignoring them in the official gate. Preserve official controller/gate
failure and null acceptance time even if benchmark qualification succeeds.
Missing checks, hard timeout, OOM, changed input or incomplete cleanup fail the
trial. Select qualified quality by length, then vias, then variant ID. First
benchmark qualification is the completing candidate's `sprint.verify.end` event,
not route completion or a proxy score. Collect phase times, full operation wall,
all-child cgroup CPU delta and cumulative terminal counter, client/cache overhead,
feedback rounds, candidate hashes/length/vias and all rejected or unfinished work.

This single follow-up is descriptive. The newer implementation and shared-host
load are confounds against historical singles. Report whether any fully checked
candidate improves verified quality or time at this ceiling; a negative result
closes the experiment. It cannot establish statistical speedup or LLM benefit.
