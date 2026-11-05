# Packed routing sprint runner (#1317)

The opt-in `sprints` route policy runs isolated seed/cost variants in one daemon
job. It reuses the existing dispatcher, cache, owned-process broker and native
verification, with one parent deadline and aggregate CPU/RAM reservation.

```text
snapshot/cache once -> native preparation and model binding
                     -> bounded core slices, separate state per variant
                     -> serialized native write, fresh gate, semantic hooks
                     -> best verified candidate + every variant's artifacts
```

The Node controller uses the core's yield/restore/finalize interfaces from #1316.
Only verified candidates participate in the final length-then-via comparison.
Search-complete, yielded, stopped and verified are distinct. No predictive
cross-seed quality pruning was enabled without #1318 evidence. Once an incumbent
exists, another verification is deferred if the longest measured verification
cost plus 20% does not fit the remaining work budget. This is scheduling
admission, not proof that the deferred route is worse. The daemon deadline and
owned cleanup remain authoritative; uncertainty blocks success.

## Actual daemon proof

Job `20261105-164020-dd6aa2` passed with one attempt, two CPUs, 4 GiB RAM, a 120 s
timeout and zero automatic retries. The existing pinned nightly image ran the
bundled Node 22.23.2 runtime. No daemon configuration or production image changed.
The server's job state was fetched independently afterward: passed, exit 0,
attempt trimmed, and its container absent.

| Observation | Result |
| --- | --- |
| Input board | Frozen ENV-SENSE copy; canonical source unchanged |
| Requested variants | Seeds 0, 1, 2, 3; via cost 3 |
| Shared preparation | One owned preparation stage |
| Peak simultaneous core slices | 2 |
| Portfolio wall time | 73.887 s |
| First fully verified candidate | 73.853 s |
| Server attempt interval | 16:40:21.363 to 16:41:37.378 UTC |
| Winner | v00, seed 0 |
| DRC errors / opens / parity errors | 0 / 0 / 0 |
| Candidate | 177 tracks, 20 vias, 262.0 mm |
| Acceptance | Fresh configured gate plus both board semantic hooks passed |
| Owned stages | 22, all cleanup confirmed |

All four variant artifact directories came back. v00 and v03 finished search;
v01 stopped and v02 retained a yielded state at the budget boundary. Alternative
verification was deferred rather than claimed to have passed. A terminal state
marker is not a resumable checkpoint; raw results and per-variant status must be
inspected. The winner is the best **verified** candidate, not a claim that every
alternative was checked or that this portfolio beats a single route.

Source PCB SHA-256:
`6abb00a0a30cd3f02d6e96a0cb326e16c1f050b735e5ed43770dcbf653844ae7`.
Winner SHA-256:
`7c4dd481c5454a055da4b956124c984cae450a17547d81c3abe5092b31316da3`.
Tested Linux router SHA-256:
`06d9160d01a88ccd73a26a8b745b1e5211bc284157020271aa03fdddebba754b`.
Node runtime SHA-256:
`3517c2df0b2f8cd7f422b4b8450ef81c6889f08eb03e281d6de9079b15e6a327`.

The direct dispatcher test exercised the real daemon, packing, cache, one job,
child ownership, native checks, semantic hooks, result download and board hash
validation. The outer `pcb` candidate gate/adoption code is unchanged and remains
required. No canonical board was adopted and no fabrication/release was performed.

## Failures retained and repaired

- Local CLI `run-deSpoR`: all four native routes were clean, but verification
  source copying incorrectly excluded a `.gate` ancestor. Fixed relative-path
  filtering and added a regression.
- Job `20261105-160653-e497d1`: default image lacked nightly IPC; failed before
  routing. Sprint jobs now select the already-allowed pinned nightly image.
- Job `20261105-161210-b73495`: routing-only input packing omitted semantic
  datasheets. Checks stayed failed. Added optional declared-snapshot packing,
  with path/symlink containment tests; the ENV closure contains 29 PDFs.
- Job `20261105-162856-af21e0`: assertions passed but a semantic hook's normal
  `operation/` evidence directory was absent. Added it with a regression.
- Job `20261105-163328-0e5c65`: a verified incumbent existed, but later native
  work timed out with cleanup unconfirmed. Success was correctly withheld.
  Measured verification-cost admission now avoids knowingly unfinishable work;
  the cleanup guard was not weakened.

Earlier failures and their returned checkpoints/logs are retained with the
successful job evidence. The cost of preparation, transfer, verification and
cleanup must remain visible in #1318; core speed alone is not an end-to-end win.

## Checks and remaining comparison

Before final integration rebase: 906 Rust tests passed, two ignored; 158
job-daemon tests passed; focused controller/transport/workflow/native-copy tests
and TypeScript checking passed. Tests cover deadline ownership, concurrency,
replay boundaries, receipt validation, cleanup refusal, early verification,
late-verification deferral, one-submit resources/retry policy, timeout artifact
retention, full snapshot selection and path containment.

After rebasing onto `c1cd2bf`, the Rust suite passed 912 tests with two ignored,
the job-daemon suite passed 166 tests, and the focused workflow/transport suite
passed 112 tests. The final receipt checks also bind the sprint policy and worker
count into benchmark fingerprints, and test parent-deadline rejection before
local fallback. The native proof above is pinned to the pre-rebase test binary;
the rebase checks are separate evidence.

#1318 still needs controlled equal-wall/equal-CPU comparisons on ENV-SENSE and
other small active boards. This proof demonstrates a working bounded runner,
not a general speedup, a new acceptance threshold, or permission for large-board
runs. Production deployment of the new release remains separate.
