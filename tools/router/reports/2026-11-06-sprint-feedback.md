# Sprint feedback: one equal-budget ESP32 follow-up

Shared reference feedback fixes the missing verification path, but this trial
shows no speed or quality advantage over the historical singles. One candidate
qualified under the preregistered benchmark definition at 853.224 seconds. Its
board is byte-identical to the singles: 956 tracks, 201 vias, 2,225 mm. The whole
portfolio used 1,631.100 CPU-seconds and ended at its normal deadline after
952.363 seconds, with complete cleanup. There was no official accepted winner.

| Trial | CPU limit / wall budget | First benchmark qualification | Whole-job CPU | Length / vias |
| --- | --- | ---: | ---: | --- |
| Historical single-a | 2 / 960 s | 658.768 s | 738.781 s | 2225 mm / 201 |
| Historical single-b | 2 / 960 s | 724.323 s | 793.480 s | 2225 mm / 201 |
| Historical single-equal-cpu | 1 / 1920 s | 694.899 s | 691.090 s | 2225 mm / 201 |
| Sprint with shared feedback | 2 / 960 s | 853.224 s | 1631.100 s | 2225 mm / 201 |

All rows have a 1,920 reserved CPU-second ceiling. Actual CPU is measured, not
assumed equal. The new candidate qualified 17.8-29.5% later than the two matched
singles; total portfolio CPU was 2.06-2.21 times theirs. One follow-up against
historical results on a shared host is descriptive, not causal or statistical
speedup evidence. Source versions differ. No LLM policy was tested.

Seed 0 entered verification at 518.806 seconds. The shared feedback loop raised
`/SPI_MISO` once and ran a full 22-pass reroute, measured at 264.8 seconds. Its
next planes screen had zero failures. Final native DRC, opens and parity were
zero; every actual configured error/failure count was zero. The unchanged gate
still failed on five stale exemptions: `/ETH_RSTn`, `/EXP_P04`, `/EXP_P06`,
`/SPI_MOSI_S`, `/WDI`, with 208 warnings. This is benchmark qualification only.
Subsequent ledger reconciliation by another task does not retroactively change
this trial's official failure or timing.

Seed 1 retained an unrouted connection. Seed 3 started verification after seed
0, but did not finish before the deadline. Seed 2 finished routing but had no
completed verification. Neither unfinished candidate counts as qualified.
The controller returned FAIL/deadline, and the harness reported ERROR because
there was no fully accepted winner. No retry, increased budget, exemption edit
or canonical adoption occurred.

Implementation and protocol were committed as
`971eefd0fbb934d3fc6f7e13a6e121a0600406ee` before submission; task comments 6113
and 6119 record registration and bindings. The Linux binary is
`fb0d6dd2200fa28728dd032786479f6437c3e8a08122e443c5c866ead4cb4320`.
Job `20261106-023219-94d1a7` had exactly one attempt, the pinned image, two CPUs
and eight GiB. A client stream disconnect required results-only recovery, not
resubmission. Container cleanup is confirmed. The final audit verified all
2,723 hardware files in both original and new fixtures, the immutable shared
prepared model, binary and measurement scripts. Host-load samples are retained.

The accompanying JSON contains the trial, historical comparison, phase evidence,
resource observations and integrity audit. Full evidence, source archive and
binary are retained under `/var/lib/cip/saved-artifacts/sprint-feedback-1416`.
Local validation passed 96 Rust run tests, 11 TypeScript controller/backend tests
and the tools typecheck. CI/merge verification is pending at this handoff.
